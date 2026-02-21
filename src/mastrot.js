#!/usr/bin/env node

/**
 * PGN Monitor and SignalK Bridge - An application to monitor specific PGNs from CAN bus
 * and forward wind data to a SignalK server
 *
 * Based on canboatjs candumpjs example
 *
 * This application monitors PGN 130306 (Wind Data) from a CAN bus,
 * forwards wind data to a SignalK server, and subscribes to updates from SignalK pypilot source.
 */

const { FromPgn, toPgn } = require('@canboat/canboatjs');
const { parseCanId } = require('@canboat/canboatjs/dist/canId');
const socketcan = require('socketcan');
const minimist = require('minimist');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const signalk = require('./signalk');
const pypilot = require('./pypilot');

// Parse command line arguments
const argv = minimist(process.argv.slice(2), {
  string: ['wind', 'skServer', 'clientId', 'mastHost', 'boatHost'],
  boolean: ['debug'],
  default: {
    wind: 'can1',
    skServer: 'localhost',
    skPort: 3000,
    debug: false,
    clientId: 'mast-rotation',
    mastHost: '10.1.1.1',
    boatHost: 'localhost',
    pypilotPort: 23322
  }
});

// Enable debug modes
const DEBUG = argv.debug;
const VERBOSE = argv.verbose || DEBUG; // Verbose is automatically enabled in debug mode

if (DEBUG) {
  console.log('Debug mode enabled');
}
if (VERBOSE && !DEBUG) {
  console.log('Verbose mode enabled');
}

const windCanDevice = argv.wind;
const skServer = argv.skServer;
const skPort = argv.skPort;
const clientId = argv.clientId;
const mastHost = argv.mastHost;
const boatHost = argv.boatHost;
const pypilotPort = argv.pypilotPort;

// Token file path
const tokenFilePath = path.join(process.cwd(), 'mastrot-token');

// State variables
let mastAngle = null; // Stores the difference between boat heading and mast heading in radians
let mastOffset = 0; // Offset for centering the mast angle
let lastMastAngleUpdate = 0; // Timestamp of last mastAngle update to SignalK
let toggleCorrect = true; // Wind correction toggle (default: enabled)

console.log(`Wind CAN device: ${windCanDevice}`);
console.log(`SignalK server: ${skServer}`);
console.log(`Signalk port: ${skPort}`);

// Variables to store the PGN data
let inputAWA = null;
let inputAWS = null;
let outputAWA = null;

// Variables to store heading data
let boatHeading = null;  // From pypilot
let canHeading = null;   // From CAN bus

// Initialize the PGN parsers
const windParser = new FromPgn({
  returnNulls: true,
  checkForInvalidFields: true,
  includeInputData: true,
  createPGNObjects: true,
  resolveEnums: true,
  canBus: windCanDevice
});

// Handle parsing errors
windParser.on('error', (pgn, error) => {
  console.error(`Error parsing wind data: ${error}`);
  console.error(error.stack);
});

// Process parsed PGNs from wind bus
windParser.on('pgn', (pgn) => {
  if (pgn.pgn === 130306) {
    // Wind Data (PGN 130306)
    if (pgn.fields) {
      inputAWA = pgn.fields.windAngle;
      inputAWS = pgn.fields.windSpeed;
      
      if (VERBOSE) {
        console.log(`Wind Data: AWA=${radToDegree(inputAWA).toFixed(1)}°, AWS=${inputAWS.toFixed(1)} m/s`);
      }
      
      // Calculate the corrected wind angle if we have both headings
      if (boatHeading !== null && canHeading !== null) {
        // Calculate and update mastAngle with proper offset and normalization
        const previousMastAngle = mastAngle;
        updateMastAngle();
        
        // Log if mastAngle has changed significantly
        if (previousMastAngle !== null && Math.abs(mastAngle - previousMastAngle) > 0.01) {
          // console.log(`Significant mastAngle change: ${previousMastAngle.toFixed(4)} -> ${mastAngle.toFixed(4)}`);
        }
        
        // Apply the mast angle to inputAWA (after updateMastAngle is called)
        // This will use the normalized and offset-adjusted mastAngle
        outputAWA = normalizeAngle(inputAWA + mastAngle);
        
        // console.log(`Wind bus: Updated Wind Data - AWA: ${inputAWA} rad, AWS: ${inputAWS} m/s, Raw Heading Diff: ${headingDiff.toFixed(4)} rad, Offset-adjusted Mast Angle: ${mastAngle.toFixed(4)} rad, Output AWA: ${outputAWA.toFixed(4)} rad`);
      } else {
        // If we don't have both headings, use the original AWA
        outputAWA = inputAWA;
        // console.log(`Wind bus: Updated Wind Data - AWA: ${inputAWA} rad, AWS: ${inputAWS} m/s (No heading correction applied)`);
      }
      
      // Forward wind data to SignalK server
      const windAngle = (toggleCorrect && outputAWA) ? outputAWA : (pgn.fields.windAngle || 0);
      const values = [
        {
          path: 'environment.wind.angleApparent',
          value: windAngle
        },
        {
          path: 'environment.wind.speedApparent',
          value: pgn.fields.windSpeed || 0
        },
        {
          path: 'environment.wind.angleApparentRaw',
          value: inputAWA !== null ? inputAWA : 0
        }
      ];
      
      // Add mastAngle if available
      if (mastAngle !== null) {
        values.push({
          path: 'sailing.mastAngle',
          value: mapAngleToDisplayRange(mastAngle)
        });
        lastMastAngleUpdate = Date.now();
      }
      
      signalk.forwardWindData({ 
        values,
        debug: {
          inputAWA: inputAWA,
          boatHeading: boatHeading,
          mastHeading: canHeading
        }
      });
    }
  }
});

// Create CAN channel
console.log(`Opening CAN device: ${windCanDevice}`);
const windChannel = socketcan.createRawChannel(windCanDevice);

// Handle channel stop events
windChannel.addListener('onStopped', (msg) => {
  console.error(`Wind CAN channel stopped: ${msg}`);
});

// Process incoming CAN messages from wind bus
windChannel.addListener('onMessage', (msg) => {
  const pgn = parseCanId(msg.id);
  
  // Process wind data messages
  if (pgn.pgn === 130306) {
    windParser.parse({
      pgn: pgn,
      length: msg.data.length,
      data: msg.data
    });
  }
});

// Function to save config (mastOffset and toggleCorrect) to file
async function saveConfig() {
  try {
    const configFilePath = path.join(process.cwd(), 'mastrot-config.json');
    const config = {
      mastOffset: mastOffset,
      toggleCorrect: toggleCorrect
    };
    await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));
    console.log(`Saved config to local file: mastOffset=${mastOffset}, windCorrection=${toggleCorrect ? 'enabled' : 'disabled'}`);
  } catch (error) {
    console.error(`Error saving config to local file: ${error.message}`);
  }
}

// Function to normalize angle to 0-2π range
function normalizeAngle(angle) {
  while (angle < 0) angle += 2 * Math.PI;
  while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
  return angle;
}

// Function to map angle to -π to π range (for mastAngle display)
// 0 to π (0° to 180°) stays the same
// π to 2π (180° to 360°) maps to -π to 0 (-180° to 0°)
function mapAngleToDisplayRange(angle) {
  // First normalize to 0-2π
  const normalizedAngle = normalizeAngle(angle);
  
  // If angle is greater than π (180°), map it to negative values
  if (normalizedAngle > Math.PI) {
    return normalizedAngle - 2 * Math.PI; // This will give a value between -π and 0
  }
  
  // Otherwise keep it as is (0 to π)
  return normalizedAngle;
}

// Function to convert radians to degrees
function radToDegree(radians) {
  return radians * 180 / Math.PI;
}

// Function to calculate heading difference using atan2 formula
function calculateHeadingDifference(heading1, heading2) {
  // Formula: Δ=atan2(sin(B−A),cos(B−A)) where B=heading2, A=heading1
  return Math.atan2(Math.sin(heading2 - heading1), Math.cos(heading2 - heading1));
}

// Function to send wind data to SignalK server (now handled by signalk module)
// This function is kept for backward compatibility but delegates to signalk module

// Initialize the application
async function initialize() {
  try {
    console.log('Initializing PGN Monitor...');
    
    // Try to load saved token
    // Load mastOffset and toggleCorrect from local file first (most recent calibration)
    const configFilePath = path.join(process.cwd(), 'mastrot-config.json');
    try {
      if (await fs.pathExists(configFilePath)) {
        const configData = await fs.readFile(configFilePath, 'utf8');
        if (configData && configData.trim()) {
          const config = JSON.parse(configData);
          if (config.mastOffset !== undefined) {
            mastOffset = parseFloat(config.mastOffset);
            console.log(`Loaded mastOffset ${mastOffset} from local file`);
          }
          if (config.toggleCorrect !== undefined) {
            toggleCorrect = config.toggleCorrect;
            console.log(`Loaded wind correction state: ${toggleCorrect ? 'enabled' : 'disabled'}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error loading config from local file: ${error.message}`);
      // Try to load from old mastrot-offset file for backward compatibility
      const offsetFilePath = path.join(process.cwd(), 'mastrot-offset');
      try {
        if (await fs.pathExists(offsetFilePath)) {
          const offsetValue = await fs.readFile(offsetFilePath, 'utf8');
          if (offsetValue && offsetValue.trim()) {
            mastOffset = parseFloat(offsetValue.trim());
            console.log(`Loaded mastOffset ${mastOffset} from legacy file`);
          }
        }
      } catch (legacyError) {
        console.error(`Error loading from legacy file: ${legacyError.message}`);
      }
    }
    
    // Fall back to environment variable if no local file
    if (mastOffset === 0 && process.env.MASTROT_OFFSET) {
      mastOffset = parseFloat(process.env.MASTROT_OFFSET);
      console.log(`Using mastOffset from environment: ${mastOffset}`);
    }
    
    if (mastOffset === 0) {
      console.log(`No saved mastOffset found, using default: ${mastOffset}`);
    }
    
    // Initialize SignalK module (for wind data forwarding only)
    signalk.init({
      skServer: skServer,
      skPort: skPort,
      clientId: clientId,
      tokenFilePath: tokenFilePath,
      debug: DEBUG,
      verbose: VERBOSE,
      onBoatHeadingUpdate: null, // Not using SignalK for heading anymore
      onConnectionStatusChange: (connected) => {
        console.log(`SignalK connection status: ${connected ? 'connected' : 'disconnected'}`);
      }
    });
    
    // Start SignalK connection
    signalk.start();
    
    // Initialize PyPilot module for heading data
    pypilot.init({
      mastHost: mastHost,
      boatHost: boatHost,
      pypilotPort: pypilotPort,
      debug: DEBUG,
      verbose: VERBOSE,
      onMastHeadingUpdate: (heading) => {
        canHeading = heading;
        if (VERBOSE) {
          console.log(`Mast Heading: ${radToDegree(heading).toFixed(1)}°`);
        }
        // Update mastAngle whenever canHeading changes and we have boatHeading
        if (boatHeading !== null) {
          updateMastAngle();
        }
        // Recalculate outputAWA if we have all the necessary data
        if (boatHeading !== null && inputAWA !== null) {
          outputAWA = normalizeAngle(inputAWA + mastAngle);
        }
      },
      onBoatHeadingUpdate: (heading) => {
        boatHeading = heading;
        if (VERBOSE) {
          console.log(`Boat Heading: ${radToDegree(heading).toFixed(1)}°`);
        }
        // Update mastAngle whenever boatHeading changes and we have canHeading
        if (canHeading !== null) {
          updateMastAngle();
        }
        // Recalculate outputAWA if we have all the necessary data
        if (canHeading !== null && inputAWA !== null) {
          outputAWA = normalizeAngle(inputAWA + mastAngle);
        }
      },
      onConnectionStatusChange: (source, connected) => {
        console.log(`PyPilot ${source} connection status: ${connected ? 'connected' : 'disconnected'}`);
      }
    });
    
    // Start PyPilot connections
    pypilot.start();
    
    // Start the CAN channel
    windChannel.start();
    console.log(`Monitoring Wind Data (PGN 130306) on ${windCanDevice}`);
    console.log(`Monitoring Mast Heading from PyPilot at ${mastHost}:${pypilotPort}`);
    console.log(`Monitoring Boat Heading from PyPilot at ${boatHost}:${pypilotPort}`);
    console.log(`Forwarding Corrected Wind Data from ${windCanDevice} to SignalK server at ${skServer}:${skPort}`);
    console.log(`Debug mode: ${DEBUG ? 'enabled' : 'disabled'} (use --debug to enable)`);
    console.log(`Verbose mode: ${VERBOSE ? 'enabled' : 'disabled'} (use --verbose to enable)`);
    
    // Add diagnostic information
    console.log('Diagnostic information:');
    console.log(`- Node.js version: ${process.version}`);
    console.log(`- Platform: ${process.platform}`);
    console.log(`- SignalK connected: ${signalk.isConnected() ? 'Yes' : 'No'}`);
    const pypilotStatus = pypilot.isConnected();
    console.log(`- PyPilot mast connected: ${pypilotStatus.mast ? 'Yes' : 'No'}`);
    console.log(`- PyPilot boat connected: ${pypilotStatus.boat ? 'Yes' : 'No'}`);
    console.log(`- Current mastOffset: ${mastOffset}`);
    console.log('Press Ctrl+C to exit');
  } catch (error) {
    console.error(`Failed to initialize: ${error.message}`);
    console.log('Will retry connection in 1 second...');
    // Instead of exiting, retry initialization after a delay
    setTimeout(initialize, 1000);
  }
}

// Function to update mastAngle and send it to SignalK if needed
function updateMastAngle() {
  if (boatHeading === null || canHeading === null) {
    return; // Can't calculate mastAngle without both headings
  }
  
  // Calculate heading difference
  const headingDiff = calculateHeadingDifference(boatHeading, canHeading);
  
  // Update mastAngle, applying the offset and normalizing the result
  // We keep mastAngle in the 0-2π range for internal calculations
  mastAngle = normalizeAngle(headingDiff - mastOffset);
  
  // For display and SignalK updates, we'll map to the -π to π range
  const displayMastAngle = mapAngleToDisplayRange(mastAngle);
  
  if (VERBOSE) {
    console.log(`boatHeading: ${radToDegree(boatHeading).toFixed(1)} mastHeading: ${radToDegree(canHeading).toFixed(1)} Updated Mast Angle: ${mastAngle.toFixed(4)} rad (display: ${displayMastAngle.toFixed(4)} rad / ${radToDegree(displayMastAngle).toFixed(1)}°)`);
  }
  
  // Send a dedicated update for mastAngle via SignalK WebSocket
  const now = Date.now();
  const signalkWs = signalk.getWebSocket();
  const wsConnected = signalk.isConnected();
  
  // Only send if it's been more than 100ms since last update to avoid flooding
  if ((now - lastMastAngleUpdate > 100) && wsConnected && signalkWs && signalkWs.readyState === 1) { // WebSocket.OPEN = 1
    try {
      // Create a simpler update message to avoid potential issues with complex objects
      const mastAngleUpdate = {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: 'pgn-monitor',
              type: 'CAN'
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'sailing.mastAngle',
                value: mapAngleToDisplayRange(mastAngle)
              }
            ]
          }
        ]
      };
      
      // Convert to JSON string
      const updateJson = JSON.stringify(mastAngleUpdate);
      
      // Send the update
      signalkWs.send(updateJson);
      lastMastAngleUpdate = now;
      // console.log(`Sent dedicated mastAngle update to SignalK: ${mastAngle.toFixed(4)} rad`);
    } catch (error) {
      console.error(`Error sending mastAngle update: ${error.message}`);
      // Don't try to reconnect here, just log the error
    }
  }
}

/**
 * API for mastrot.js
 *
 * This module provides an API to interact with the mastrot functionality.
 * It exposes functions to control and interact with the mast rotation correction system.
 */

// API object that contains all exposed functions
const api = {
  /**
   * Center the mast angle
   *
   * This function resets/centers the mast angle calculation by setting the current
   * difference between boat heading and mast heading as the new reference point.
   *
   * @returns {Object} Result object with success status and message
   */
  center: async function() {
    try {
      console.log("center function");
      // Check if mastrot system is initialized
      if (boatHeading === null || canHeading === null) {
        return {
          success: false,
          message: "Cannot center: Missing heading data from boat or mast"
        };
      }
      
      // Calculate the current heading difference
      const currentDiff = calculateHeadingDifference(boatHeading, canHeading);
      
      // Set this as the new mastOffset
      mastOffset = currentDiff;
      
      // Update the mastAngle calculation
      updateMastAngle();
      
      // Save mastOffset to a local file as a backup
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving config to local file: ${fileError.message}`);
        // Continue even if local save fails
      }
      
      console.log(`mast angle centered at ${mastOffset}`);
      return {
        success: true,
        message: "Mast angle centered successfully",
        offset: mastOffset
      };
    } catch (error) {
      return {
        success: false,
        message: `Error centering mast angle: ${error.message}`
      };
    }
  },
  
  /**
   * Reset the mast angle offset to zero
   *
   * @returns {Object} Result object with success status and message
   */
  reset: async function() {
    try {
      mastOffset = 0;
      updateMastAngle();
      
      // Save mastOffset to a local file as a backup
      try {
        await saveConfig();
      } catch (fileError) {
        console.error(`Error saving reset config to local file: ${fileError.message}`);
        // Continue even if local save fails
      }
      
      console.log("mast angle reset");
      return {
        success: true,
        message: 'Mast rotation offset reset to 0'
      };
    } catch (error) {
      return {
        success: false,
        message: `Error resetting: ${error.message}`
      };
    }
  }
};

// Create Express API server
const app = express();
const PORT = process.env.MASTROT_PORT ? parseInt(process.env.MASTROT_PORT) : 3333;

// Middleware to parse JSON bodies
app.use(express.json());

// Add CORS middleware to allow cross-origin requests
app.use((req, res, next) => {
  // Allow requests from any origin
  res.header('Access-Control-Allow-Origin', '*');
  // Allow specific headers
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  // Allow specific methods
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// API routes
app.get('/api/status', (req, res) => {
  res.json({
    mastAngle: mastAngle !== null ? mapAngleToDisplayRange(mastAngle) : 0,
    mastAngleRaw: mastAngle !== null ? mastAngle : 0,
    mastAngleDegrees: mastAngle !== null ? radToDegree(mapAngleToDisplayRange(mastAngle)) : 0,
    mastOffset: mastOffset,
    boatHeading: boatHeading !== null ? boatHeading : 0,
    canHeading: canHeading !== null ? canHeading : 0,
    inputAWA: inputAWA !== null ? inputAWA : 0,
    inputAWADegrees: inputAWA !== null ? radToDegree(inputAWA) : 0,
    inputAWS: inputAWS !== null ? inputAWS : 0,
    outputAWA: outputAWA !== null ? outputAWA : 0,
    outputAWADegrees: outputAWA !== null ? radToDegree(outputAWA) : 0,
    toggleCorrect: toggleCorrect
  });
});

// Add GET handlers for center and reset operations
app.get('/api/center', async (req, res) => {
  console.log("GET center request received");
  const result = await api.center();
  res.json(result);
});

app.get('/api/reset', async (req, res) => {
  console.log("GET reset request received");
  const result = await api.reset();
  res.json(result);
});

app.get('/api/wind-correction', async (req, res) => {
  // If enabled parameter is provided, update the state
  if (req.query.enabled !== undefined) {
    const enabled = req.query.enabled === 'true';
    toggleCorrect = enabled;
    console.log(`Wind correction ${enabled ? 'enabled' : 'disabled'}`);
    
    // Save the config
    try {
      await saveConfig();
    } catch (error) {
      console.error(`Error saving config: ${error.message}`);
    }
  }
  
  // Always return the current state
  res.json({
    success: true,
    enabled: toggleCorrect,
    message: `Wind correction ${toggleCorrect ? 'enabled' : 'disabled'}`
  });
});

// Export variables and functions for API
module.exports = {
  // Variables
  get mastAngle() { return mastAngle; },
  get mastAngleMapped() { return mapAngleToDisplayRange(mastAngle); },
  get boatHeading() { return boatHeading; },
  get canHeading() { return canHeading; },
  get mastOffset() { return mastOffset; },
  set mastOffset(value) { mastOffset = value; },
  
  // Functions
  calculateHeadingDifference,
  updateMastAngle,
  normalizeAngle,
  mapAngleToDisplayRange,
  
  // API
  api,
  
  // Express app
  app,
  
  // Start Express server
  startServers: function(expressPort = PORT) {
    // Start Express server
    app.listen(expressPort, () => {
      console.log(`Express API server listening on port ${expressPort}`);
    }).on('error', (err) => {
      console.error(`Failed to start Express server: ${err.message}`);
    });
    
    return this;
  }
};

// Start the application
initialize();

// Start the API server if this file is run directly
if (require.main === module) {
  console.log("Starting Express server on port 3333...");
  // Start Express server
  module.exports.startServers();
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('Closing CAN channel, WebSocket connection, and API server...');
    windChannel.stop();
    if (signalkWs) {
      signalkWs.close();
    }
    process.exit(0);
  });
} else {
  // If imported as a module, just handle Ctrl+C for the CAN and WebSocket
  process.on('SIGINT', () => {
    console.log('Closing CAN channel and WebSocket connection...');
    windChannel.stop();
    if (signalkWs) {
      signalkWs.close();
    }
    process.exit(0);
  });
}