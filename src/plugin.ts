/*
 * SignalK Plugin for Mast Rotation Angle
 * This plugin displays and manages mast rotation angle data
 */

import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { Plugin, ServerAPI } from '@signalk/server-api'

// Add Node.js process type
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
      // Check if plugin is enabled
      if (options.enabled === false) {
        app.setPluginStatus('Disabled')
        return
      }
      
      app.debug('Mast Rotation plugin started')
      
      // Set debug logging based on configuration
      const debugLogging = options.enableDebug === true
      
      // Debug logging
      
      if (debugLogging) {
        app.debug('Debug logging enabled')
      }
      
      // Setup data logging if enabled
      const dataLogging = options.enableLogging === true
      
      if (dataLogging) {
        app.debug('Data logging enabled')
        // Initialize data logging functionality
        // This would typically write to a file or database
        dataLogger = {
          active: true,
          startTime: new Date().toISOString()
        }
      }
      
      // Spawn the mastrot.js process
      try {
        // Get the configured port and mastOffset or use defaults
        const mastRotHelperPort = options.mastRotHelperPort || 3333
        const mastOffset = options.mastOffset || 0
        
        // Log the mastOffset value from persistent storage
        app.debug(`Loading mastOffset from persistent storage: ${mastOffset}`)
        
        // Use the current plugin directory as the base for finding mastrot.js
        const pluginDir = path.join(process.cwd(), 'node_modules', 'mastrot');
        const mastrotScriptPath = path.join(pluginDir, 'src', 'mastrot.js');
        app.debug(`Using mastrot.js path: ${mastrotScriptPath}`);
        
        mastrotProcess = spawn('node', [mastrotScriptPath], {
          // Pass any necessary environment variables
          env: {
            ...process.env,
            // Add plugin-specific environment variables if needed
            PLUGIN_DEBUG: debugLogging ? 'true' : 'false',
            MASTROT_PORT: mastRotHelperPort.toString(),
            MASTROT_OFFSET: mastOffset.toString()
          }
        })
        
        // Handle process stdout
        mastrotProcess?.stdout?.on('data', (data) => {
          const message = data.toString().trim()
          if (message) {
            app.debug(`mastrot stdout: ${message}`)
          }
        })
        
        // Handle process stderr
        mastrotProcess?.stderr?.on('data', (data) => {
          const message = data.toString().trim()
          if (message) {
            app.error(`mastrot stderr: ${message}`)
          }
        })
        
        // Handle process exit
        mastrotProcess.on('exit', (code, signal) => {
          if (code !== 0) {
            app.error(`mastrot process exited with code ${code}, signal: ${signal}`)
            app.setPluginError(`mastrot process exited unexpectedly with code ${code}`)
          } else {
            app.debug('mastrot process exited normally')
          }
          mastrotProcess = null
        })
        
        // Handle process error
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
      
      // Register the web app for the plugin
      app.setPluginStatus('Running')
      
      // Subscribe to mastAngle updates with format and policy parameters
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
        // Catch any synchronous errors from the subscription attempt
        app.error(`Failed to subscribe to mastAngle: ${error instanceof Error ? error.message : String(error)}`)
        app.debug('Continuing plugin operation despite subscription error')
      }
      
      // Handle incoming data
      function onSubscriptionData(data: any) {
        if (data && data.updates) {
          data.updates.forEach((update: any) => {
            if (update.values) {
              update.values.forEach((value: any) => {
                if (value.path === 'sailing.mastAngle') {
                  // Process mastAngle data
                  const mastAngle = value.value
                  
                  // Log data if debug logging is enabled
                  if (debugLogging) {
                    app.debug(`Received mastAngle update: ${mastAngle}`)
                  }
                  
                  // Record data if data logging is enabled
                  if (dataLogging) {
                    const timestamp = new Date().toISOString()
                    const logEntry = {
                      timestamp,
                      mastAngle
                    }
                    // In a real implementation, this would write to a file or database
                    if (debugLogging) {
                      app.debug(`Logging data: ${JSON.stringify(logEntry)}`)
                    }
                  }
                  
                  // Send to clients via WebSocket if needed
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
        
        // Don't let subscription errors crash the plugin
        app.debug('Continuing plugin operation despite subscription error')
        
        // If the error is related to unsubscribes.push, log a more helpful message
        if (error.message.includes('unsubscribes.push')) {
          app.debug('This is a known issue with older SignalK servers. The plugin will continue to function.')
        }
      }
    },
    
    stop: function () {
      app.debug('Mast Rotation plugin stopped')
      app.setPluginStatus('Stopped')
      
      // Close data logger if it exists
      if (dataLogger) {
        app.debug('Closing data logger')
        // In a real implementation, this would close file handles or database connections
        dataLogger = null
      }
      
      // Terminate the mastrot process if it's running
      if (mastrotProcess) {
        app.debug('Terminating mastrot process')
        try {
          // First try to gracefully terminate the process
          mastrotProcess.kill('SIGTERM')
          
          // Set a timeout to force kill if it doesn't exit gracefully
          setTimeout(() => {
            if (mastrotProcess) {
              app.debug('Force killing mastrot process')
              mastrotProcess.kill('SIGKILL')
              mastrotProcess = null
            }
          }, 5000) // 5 second timeout
        } catch (error) {
          app.error(`Error terminating mastrot process: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      
      // Unsubscribe from updates with error handling
      try {
        unsubscribes.forEach(unsubscribe => unsubscribe())
        app.debug('Successfully unsubscribed from SignalK updates')
      } catch (error) {
        app.error(`Error unsubscribing: ${error instanceof Error ? error.message : String(error)}`)
        app.debug('Continuing plugin shutdown despite unsubscribe error')
      }
    },
    
    registerWithRouter: function (router: any) {
      // Get the configured port from plugin options
      const pluginOptions: any = app.getSelfPath('options')
      const mastRotHelperPort = (pluginOptions && pluginOptions.mastRotHelperPort) ? pluginOptions.mastRotHelperPort : 3333
      
      // Serve the web app from the plugin's public directory
      router.get('/', (req: any, res: any) => {
        // Serve the HTML file with a script that sets the port
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
      
      // Serve static files from the public directory
      router.use(require('serve-static')(path.join(process.cwd(), 'public')))
      
      // Add body-parser middleware to parse JSON request bodies
      router.use(require('body-parser').json())
      
      // Forward API requests to the Express server in mastrot.js
      // This is just a fallback - the Express server in mastrot.js handles API requests directly
      router.get('/api/*', (req: any, res: any) => {
        const pluginOptions: any = app.getSelfPath('options')
        const mastRotHelperPort = (pluginOptions && pluginOptions.mastRotHelperPort) ? pluginOptions.mastRotHelperPort : 3333
        
        // Use a proper HTTP client to forward the GET request
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
        
        // Use a proper HTTP client to forward the POST request
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
        
        // Forward the request body if it exists
        if (req.body) {
          proxyReq.write(JSON.stringify(req.body))
        }
        
        proxyReq.end()
      })
    }
  }
  
  return plugin
}
