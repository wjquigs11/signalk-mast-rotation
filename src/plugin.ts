import * as path from 'path'
import { Plugin, ServerAPI } from '@signalk/server-api'
import * as canTransmit from './can-transmit'

export default function (app: ServerAPI): Plugin {
  let unsubscribe: (() => void) | null = null
  let canTransmitEnabled: boolean = false
  let currentSettings: any = {
    mastHost: '10.1.1.1',
    mastRotHelperPort: 3333
  }

  const plugin: Plugin = {
    id: 'mastrot',
    name: 'Mast Rotation Angle',
    description: 'Plugin for mast rotation angle',
    enabledByDefault: true,
    schema: {
      type: 'object',
      properties: {
        mastHost: {
          type: 'string',
          title: 'Mast host',
          default: '10.1.1.1'
        },
        mastRotHelperPort: {
          type: 'number',
          title: 'Mast rotation helper port',
          default: 3333
        }
      }
    },
    start: function (options: any) {
      currentSettings = options || {}
      app.debug('Mast Rotation plugin started')
      app.debug(`mastHost: ${currentSettings.mastHost || '10.1.1.1'}, mastRotHelperPort: ${currentSettings.mastRotHelperPort || 3333}`)

      if (options.enableCanTransmit === true) {
        canTransmitEnabled = true
        const outputCanDevice = options.outputCanDevice || 'can1'
        const canInitSuccess = canTransmit.initCanTransmit({
          device: outputCanDevice,
          debug: false,
          onError: (error: string) => { app.error(`CAN transmit error: ${error}`) },
          onStatusChange: (connected: boolean) => { app.debug(`CAN transmit status: ${connected ? 'connected' : 'disconnected'}`) }
        })
        if (canInitSuccess) {
          let lastAWA: number | null = null
          let lastAWS: number | null = null
          const pollInterval = setInterval(() => {
            try {
              const awaValue = app.getSelfPath('environment.wind.angleApparent.value')
              const awsValue = app.getSelfPath('environment.wind.speedApparent.value')
              if (awaValue !== undefined && awaValue !== null && typeof awaValue === 'number') lastAWA = awaValue
              if (awsValue !== undefined && awsValue !== null && typeof awsValue === 'number') lastAWS = awsValue
              if (lastAWA !== null && lastAWS !== null) canTransmit.transmitWindData(lastAWA, lastAWS)
            } catch (error) {
              app.error(`Error reading wind data: ${error instanceof Error ? error.message : String(error)}`)
            }
          }, 100)
          unsubscribe = () => { clearInterval(pollInterval) }
        } else {
          app.setPluginError('Failed to initialize CAN transmission')
        }
      }

      app.setPluginStatus('Running')
    },

    stop: function () {
      app.debug('Mast Rotation plugin stopped')
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      if (canTransmitEnabled) { canTransmit.stopCanTransmit(); canTransmitEnabled = false }
      app.setPluginStatus('Stopped')
    },

    registerWithRouter: function (router: any) {
      router.use((req: any, res: any, next: any) => {
        console.log(`mastrot router: ${req.method} ${req.url}`)
        next()
      })
      router.use(require('body-parser').json())

      // Expose config to the UI - read directly from config file so it's always current
      router.get('/config', (req: any, res: any) => {
        const fs = require('fs')
        const configPath = path.join(
          process.env.SIGNALK_NODE_CONFIG_DIR || path.join(process.env.HOME || '', '.signalk'),
          'plugin-config-data', 'mastrot.json'
        )
        console.log(`mastrot /config: reading from ${configPath}`)
        try {
          const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
          const cfg = saved.configuration || saved
          console.log(`mastrot /config: file contents: ${JSON.stringify(cfg)}`)
          res.setHeader('Cache-Control', 'no-store')
          res.json({
            mastHost: cfg.mastHost || currentSettings.mastHost,
            mastRotHelperPort: cfg.mastRotHelperPort || currentSettings.mastRotHelperPort
          })
        } catch (e) {
          console.log(`mastrot /config: file read failed (${e}), currentSettings: ${JSON.stringify(currentSettings)}`)
          res.setHeader('Cache-Control', 'no-store')
          res.json({
            mastHost: currentSettings.mastHost,
            mastRotHelperPort: currentSettings.mastRotHelperPort
          })
        }
      })

      router.get('/api/*', (req: any, res: any) => {
        const mastRotHelperPort = currentSettings.mastRotHelperPort || 3333
        const http = require('http')
        const proxyReq = http.request(
          { hostname: 'localhost', port: mastRotHelperPort, path: req.url, method: 'GET', headers: req.headers },
          (proxyRes: any) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res) }
        )
        proxyReq.on('error', (error: Error) => {
          app.error(`Error proxying GET request: ${error.message}`)
          res.status(500).send(`Error proxying request: ${error.message}`)
        })
        proxyReq.end()
      })

      router.post('/api/*', (req: any, res: any) => {
        const mastRotHelperPort = currentSettings.mastRotHelperPort || 3333
        const http = require('http')
        const proxyReq = http.request(
          { hostname: 'localhost', port: mastRotHelperPort, path: req.url, method: 'POST',
            headers: { ...req.headers, 'Content-Type': 'application/json' } },
          (proxyRes: any) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res) }
        )
        proxyReq.on('error', (error: Error) => {
          app.error(`Error proxying POST request: ${error.message}`)
          res.status(500).send(`Error proxying request: ${error.message}`)
        })
        if (req.body) proxyReq.write(JSON.stringify(req.body))
        proxyReq.end()
      })

      router.use(require('serve-static')(path.join(process.cwd(), 'public')))
    }
  }
  return plugin
}
