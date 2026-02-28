import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { Plugin, ServerAPI } from '@signalk/server-api'

export default function (app: ServerAPI): Plugin {
  let dataLogger: any = null
  let mastrotProcess: ChildProcess | null = null
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
      try {
        const mastRotHelperPort = options.mastRotHelperPort || 3333
        const mastOffset = options.mastOffset || 0
        const windCanDevice = options.windCanDevice || 'can1'
        const mastHost = options.mastHost || '10.1.1.1'
        const boatHost = options.boatHost || 'localhost'
        const pypilotPort = options.pypilotPort || 23322
        app.debug(`Loading mastOffset from persistent storage: ${mastOffset}`)
        const pluginDir = path.join(process.cwd(), 'node_modules', 'mastrot');
        const mastrotScriptPath = path.join(pluginDir, 'src', 'mastrot.js');
        app.debug(`Using mastrot.js path: ${mastrotScriptPath}`);
        const fs = require('fs-extra');
        const configFilePath = path.join(pluginDir, 'mastrot-config.json');
        const config = {
          windCanDevice: windCanDevice,
          mastHost: mastHost,
          boatHost: boatHost,
          pypilotPort: pypilotPort
        };
        try {
          fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));
          app.debug(`Wrote configuration to ${configFilePath}`);
        } catch (writeError) {
          app.error(`Failed to write config file: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
        }        mastrotProcess = spawn('node', [mastrotScriptPath], {
          env: {
            ...process.env,
            PLUGIN_DEBUG: debugLogging ? 'true' : 'false',
            MASTROT_PORT: mastRotHelperPort.toString(),
            MASTROT_OFFSET: mastOffset.toString()
          }
        })
        mastrotProcess?.stdout?.on('data', (data) => {
          const message = data.toString().trim()
          if (message) {
            app.debug(`mastrot stdout: ${message}`)
          }
        })
        mastrotProcess?.stderr?.on('data', (data) => {
          const message = data.toString().trim()
          if (message) {
            app.error(`mastrot stderr: ${message}`)
          }
        })
        mastrotProcess.on('exit', (code, signal) => {
          if (code !== 0) {
            app.error(`mastrot process exited with code ${code}, signal: ${signal}`)
            app.setPluginError(`mastrot process exited unexpectedly with code ${code}`)
          } else {
            app.debug('mastrot process exited normally')
          }
          mastrotProcess = null
        })
        mastrotProcess.on('error', (err) => {
          app.error(`Error in mastrot process: ${err.message}`)
          app.setPluginError(`mastrot process error: ${err.message}`)
          mastrotProcess = null
        })
        app.debug('mastrot process started successfully')
      } catch (error) {
        app.error(`Failed to spawn mastrot process: ${error instanceof Error ? error.message : String(error)}`)
        app.setPluginError(`Failed to spawn mastrot process: ${error instanceof Error ? error.message : String(error)}`)
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
          // mastrot.js is managed by systemd, not by this plugin
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