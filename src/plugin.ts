import * as path from 'path'
import { Plugin, ServerAPI } from '@signalk/server-api'
import * as canTransmit from './can-transmit'

export default function (app: ServerAPI): Plugin {
  let dataLogger: any = null
  let unsubscribe: (() => void) | null = null
  let canTransmitEnabled: boolean = false
  const plugin: Plugin = {
    id: 'mastrot',
    name: 'Mast Rotation Angle',
    description: 'Plugin for mast rotation angle',
    enabledByDefault: true,
    uiSchema: {
      'ui:appKey': 'mastrot-plugin'
    },
    schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          title: 'Mode',
          enum: ['mast', 'boat'],
          default: 'mast'
        },
        mastRotHelperPort: {
          type: 'number',
          title: 'Mast rotation helper port',
          default: 3333
        },
        windCanDevice: {
          type: 'string',
          title: 'Wind CAN device',
          default: 'can0'
        },
        mastHost: {
          type: 'string',
          title: 'Mast pypilot host',
          default: '10.1.1.1'
        },
        boatHost: {
          type: 'string',
          title: 'Boat pypilot host',
          default: 'localhost'
        },
        pypilotPort: {
          type: 'number',
          title: 'pypilot Port',
          description: 'Port number for pypilot connections',
          default: 23322
        },
        enableCanTransmit: {
          type: 'boolean',
          title: 'Enable CAN transmission',
          description: 'Enable transmission of wind data to CAN bus',
          default: false
        },
        outputCanDevice: {
          type: 'string',
          title: 'Output CAN device',
          description: 'CAN interface for transmitting wind data (e.g., can0, can1)',
          default: 'can1'
        }
      }
    },
    start: function (options: any) {
      if (options.enabled === false) {
        app.setPluginStatus('Disabled')
        return
      }
      app.debug('Mast Rotation plugin started')
      const debugLogging = options.enableDebug === true
      if (debugLogging) {
        app.debug('Debug logging enabled')
      }
      const dataLogging = options.enableLogging === true
      if (dataLogging) {
        app.debug('Data logging enabled')
        dataLogger = {
          active: true,
          startTime: new Date().toISOString()
        }
      }

      // Initialize CAN transmission if enabled
      if (options.enableCanTransmit === true) {
        canTransmitEnabled = true
        const outputCanDevice = options.outputCanDevice || 'can1'
        
        app.debug(`Initializing CAN transmission on ${outputCanDevice}`)
        
        const canInitSuccess = canTransmit.initCanTransmit({
          device: outputCanDevice,
          debug: debugLogging,
          onError: (error: string) => {
            app.error(`CAN transmit error: ${error}`)
          },
          onStatusChange: (connected: boolean) => {
            app.debug(`CAN transmit status: ${connected ? 'connected' : 'disconnected'}`)
          }
        })

        if (canInitSuccess) {
          app.debug('CAN transmit initialized successfully')
          
          // Subscribe to wind data at 10Hz (100ms period)
          const subscription = {
            context: 'vessels.self',
            subscribe: [
              {
                path: 'environment.wind.angleApparent',
                period: 100
              },
              {
                path: 'environment.wind.speedApparent',
                period: 100
              }
            ]
          }

          app.debug('Subscribing to wind data: ' + JSON.stringify(subscription))

          let lastAWA: number | null = null
          let lastAWS: number | null = null

          // Poll wind data at 10Hz
          const pollInterval = setInterval(() => {
            try {
              const awaValue = app.getSelfPath('environment.wind.angleApparent.value')
              const awsValue = app.getSelfPath('environment.wind.speedApparent.value')

              if (awaValue !== undefined && awaValue !== null && typeof awaValue === 'number') {
                lastAWA = awaValue
              }
              if (awsValue !== undefined && awsValue !== null && typeof awsValue === 'number') {
                lastAWS = awsValue
              }

              // Transmit if we have both values
              if (lastAWA !== null && lastAWS !== null) {
                canTransmit.transmitWindData(lastAWA, lastAWS)
              }
            } catch (error) {
              app.error(`Error reading wind data: ${error instanceof Error ? error.message : String(error)}`)
            }
          }, 100) // 10Hz = 100ms

          // Store cleanup function
          unsubscribe = () => {
            clearInterval(pollInterval)
          }
          
          app.debug('Successfully started wind data polling at 10Hz')
        } else {
          app.error('Failed to initialize CAN transmission')
          app.setPluginError('Failed to initialize CAN transmission')
        }
      }

      app.setPluginStatus('Running')
    },
    stop: function () {
      app.debug('Mast Rotation plugin stopped')
      app.setPluginStatus('Stopped')
      
      if (dataLogger) {
        app.debug('Closing data logger')
        dataLogger = null
      }

      // Unsubscribe from wind data
      if (unsubscribe) {
        app.debug('Unsubscribing from wind data')
        unsubscribe()
        unsubscribe = null
      }

      // Stop CAN transmission
      if (canTransmitEnabled) {
        app.debug('Stopping CAN transmission')
        canTransmit.stopCanTransmit()
        canTransmitEnabled = false
      }
    },
    registerWithRouter: function (router: any) {
      const pluginOptions: any = app.getSelfPath('options')
      const mastRotHelperPort = (pluginOptions && pluginOptions.mastRotHelperPort) ? pluginOptions.mastRotHelperPort : 3333
      router.get('/', (req: any, res: any) => {
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <script>
              // Set the port from SignalK configuration
              window.mastRotHelperPort = ${mastRotHelperPort};
            </script>
          </head>
          <body>
            <script>
              // Redirect to the actual index.html with the port set
              window.location.href = 'index.html';
            </script>
          </body>
          </html>
        `)
      })
      router.use(require('serve-static')(path.join(process.cwd(), 'public')))
      router.use(require('body-parser').json())
      router.get('/api/*', (req: any, res: any) => {
        const pluginOptions: any = app.getSelfPath('options')
        const mastRotHelperPort = (pluginOptions && pluginOptions.mastRotHelperPort) ? pluginOptions.mastRotHelperPort : 3333
        const http = require('http')
        const options = {
          hostname: 'localhost',
          port: mastRotHelperPort,
          path: req.url,
          method: 'GET',
          headers: req.headers
        }
        const proxyReq = http.request(options, (proxyRes: any) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(res)
        })
        proxyReq.on('error', (error: Error) => {
          app.error(`Error proxying GET request: ${error.message}`)
          res.status(500).send(`Error proxying request: ${error.message}`)
        })
        proxyReq.end()
      })
      router.post('/api/*', (req: any, res: any) => {
        const pluginOptions: any = app.getSelfPath('options')
        const mastRotHelperPort = (pluginOptions && pluginOptions.mastRotHelperPort) ? pluginOptions.mastRotHelperPort : 3333
        const http = require('http')
        const options = {
          hostname: 'localhost',
          port: mastRotHelperPort,
          path: req.url,
          method: 'POST',
          headers: {
            ...req.headers,
            'Content-Type': 'application/json'
          }
        }
        const proxyReq = http.request(options, (proxyRes: any) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(res)
        })
        proxyReq.on('error', (error: Error) => {
          app.error(`Error proxying POST request: ${error.message}`)
          res.status(500).send(`Error proxying request: ${error.message}`)
        })
        if (req.body) {
          proxyReq.write(JSON.stringify(req.body))
        }
        proxyReq.end()
      })
    }
  }
  return plugin
}