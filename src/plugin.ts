import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { Plugin, ServerAPI } from '@signalk/server-api'
declare const process: {
  cwd(): string;
  [key: string]: any;
};
export default function (app: ServerAPI): Plugin {
  let dataLogger: any = null
  let mastrotProcess: ChildProcess | null = null
  const unsubscribes: any[] = []
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
        mastRotHelperPort: {
          type: 'number',
          title: 'Mast Rotation Helper Port',
          description: 'Port number for the Mast Rotation Helper service',
          default: 3333
        },
        schemaThing: {
          type: 'number',
          description: 'randomThing'
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
        app.debug(`Loading mastOffset from persistent storage: ${mastOffset}`)
        const pluginDir = path.join(process.cwd(), 'node_modules', 'mastrot');
        const mastrotScriptPath = path.join(pluginDir, 'src', 'mastrot.js');
        app.debug(`Using mastrot.js path: ${mastrotScriptPath}`);
        mastrotProcess = spawn('node', [mastrotScriptPath], {
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
      try {
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self' as any,
            subscribe: [
              {
                path: 'sailing.mastAngle' as any,
                period: 500,
                format: 'delta',
                policy: 'fixed'
              }
            ]
          },
          unsubscribes,
          subscriptionError,
          () => {
            app.debug('Subscription initialized')
          }
        )
        app.debug('Successfully subscribed to mastAngle updates')
      } catch (error) {
        app.error(`Failed to subscribe to mastAngle: ${error instanceof Error ? error.message : String(error)}`)
        app.debug('Continuing plugin operation despite subscription error')
      }
      function onSubscriptionData(data: any) {
        if (data && data.updates) {
          data.updates.forEach((update: any) => {
            if (update.values) {
              update.values.forEach((value: any) => {
                if (value.path === 'sailing.mastAngle') {
                  const mastAngle = value.value
                  if (debugLogging) {
                    app.debug(`Received mastAngle update: ${mastAngle}`)
                  }
                  if (dataLogging) {
                    const timestamp = new Date().toISOString()
                    const logEntry = {
                      timestamp,
                      mastAngle
                    }
                    if (debugLogging) {
                      app.debug(`Logging data: ${JSON.stringify(logEntry)}`)
                    }
                  }
                  app.handleMessage('mastrot-plugin', {
                    updates: [
                      {
                        values: [
                          {
                            path: 'plugins.mastrot.angle' as any,
                            value: mastAngle
                          }
                        ]
                      }
                    ]
                  })
                }
              })
            }
          })
        }
      }
      function subscriptionError(err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err))
        app.error(`Error in mastrot subscription: ${error.message}`)
        app.setPluginError(`Subscription error: ${error.message}`)
        app.debug('Continuing plugin operation despite subscription error')
        if (error.message.includes('unsubscribes.push')) {
          app.debug('This is a known issue with older SignalK servers. The plugin will continue to function.')
        }
      }
    },
    stop: function () {
      app.debug('Mast Rotation plugin stopped')
      app.setPluginStatus('Stopped')
      if (dataLogger) {
        app.debug('Closing data logger')
        dataLogger = null
      }
      if (mastrotProcess) {
        app.debug('Terminating mastrot process')
        try {
          mastrotProcess.kill('SIGTERM')
          setTimeout(() => {
            if (mastrotProcess) {
              app.debug('Force killing mastrot process')
              mastrotProcess.kill('SIGKILL')
              mastrotProcess = null
            }
          }, 5000) 
        } catch (error) {
          app.error(`Error terminating mastrot process: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        unsubscribes.forEach(unsubscribe => unsubscribe())
        app.debug('Successfully unsubscribed from SignalK updates')
      } catch (error) {
        app.error(`Error unsubscribing: ${error instanceof Error ? error.message : String(error)}`)
        app.debug('Continuing plugin shutdown despite unsubscribe error')
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