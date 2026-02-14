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
const WebSocket = require('ws');
// Define WebSocket states for readability
WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

// Parse command line arguments
const argv = minimist(process.argv.slice(2), {
  string: ['wind', 'skServer', 'clientId'],
  boolean: ['debug'],
  default: {
    wind: 'can1',
    skServer: 'localhost',
    skPort: 3000,
    debug: false,
    clientId: 'mast-rotation'
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

// Token file path
const tokenFilePath = path.join(process.cwd(), 'mastrot-token');

// SignalK connection
let signalkWs = null;
let wsConnected = false;
let authToken = null;
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
      forwardWindData(pgn);
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
  
  // Process heading data from CAN bus (PGN 127250 - Vessel Heading)
  if (pgn.pgn === 127250) {
    // Parse the heading data
    const headingParser = new FromPgn({
      returnNulls: true,
      checkForInvalidFields: true,
      includeInputData: true,
      createPGNObjects: true,
      resolveEnums: true,
      canBus: windCanDevice
    });
    
    headingParser.on('pgn', (headingPgn) => {
      if (headingPgn.pgn === 127250 && headingPgn.fields && headingPgn.fields.heading !== undefined) {
        canHeading = headingPgn.fields.heading;
        // console.log(`CAN bus: Updated Heading - ${canHeading} rad`);
        
        // Update mastAngle whenever canHeading changes and we have boatHeading
        if (boatHeading !== null) {
          updateMastAngle();
        }
      }
    });
    
    headingParser.parse({
      pgn: pgn,
      length: msg.data.length,
      data: msg.data
    });
  }
});

// Function to load token from file
async function loadToken() {
  try {
    if (await fs.pathExists(tokenFilePath)) {
      const token = await fs.readFile(tokenFilePath, 'utf8');
      if (token && token.trim()) {
        console.log('Loaded authentication token from file');
        return token.trim();
      }
    }
    console.log('No saved token found');
    return null;
  } catch (error) {
    console.error(`Error loading token: ${error.message}`);
    return null;
  }
}

// Function to save token to file
async function saveToken(token) {
  try {
    await fs.writeFile(tokenFilePath, token);
    console.log('Saved authentication token to file');
  } catch (error) {
    console.error(`Error saving token: ${error.message}`);
  }
}

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

// Function to request access token
async function requestAccessToken() {
  try {
    console.log('Requesting access token from SignalK server...');
    
    const response = await fetch(`http://${skServer}:${skPort}/signalk/v1/access/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId,
        description: 'Mast Rotation Correction'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Access request submitted. Please approve the request in the SignalK server interface.');
      console.log(`Request ID: ${data.requestId}`);
      
      // Start polling for token approval
      pollForToken(data.href);
      return null;
    } else {
      console.error(`Failed to request access: ${response.status} ${response.statusText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error requesting access token: ${error.message}`);
    // Instead of returning null, retry after a delay
    console.log('Will retry requesting access token in 1 second...');
    setTimeout(requestAccessToken, 1000);
    return null;
  }
}

// Function to poll for token approval
async function pollForToken(href) {
  try {
    console.log('Checking token status...');
    
    const response = await fetch(`http://${skServer}:${skPort}${href}`);
    if (!response.ok) {
      console.error(`Failed to check token status: ${response.status} ${response.statusText}`);
      setTimeout(() => pollForToken(href), 5000);
      return;
    }
    
    const data = await response.json();
    
    if (data.state === 'COMPLETED') {
      if (data.accessRequest && data.accessRequest.permission === 'APPROVED') {
        console.log('Access request approved!');
        authToken = data.accessRequest.token;
        await saveToken(authToken);
        
        // Now that we have a token, connect to WebSocket
        connectToSignalK();
      } else {
        console.error('Access request was denied or expired');
        setTimeout(() => requestAccessToken(), 10000);
      }
    } else {
      console.log('Access request still pending. Waiting for approval...');
      setTimeout(() => pollForToken(href), 5000);
    }
  } catch (error) {
    console.error(`Error polling for token: ${error.message}`);
    // Retry more frequently (1 second) if there's a connection issue
    if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch')) {
      console.log('Connection issue detected, retrying in 1 second...');
      setTimeout(() => pollForToken(href), 1000);
    } else {
      // For other errors, keep the original 5-second retry
      setTimeout(() => pollForToken(href), 5000);
    }
  }
}

// Function to connect to SignalK WebSocket
function connectToSignalK() {
  try {
    // Use the correct SignalK WebSocket endpoint with proper query parameter format
    let wsUrl = `ws://${skServer}:${skPort}/signalk/v1/stream?subscribe=none`;
    
    // Add token if available - use proper query parameter format
    if (authToken) {
      wsUrl += `&token=${authToken}`;
    }
    
    // Fix the URL format if needed
    wsUrl = wsUrl.replace('?subscribe=none&token=', '?token=');
    
    console.log(`Connecting to SignalK WebSocket at ${wsUrl}`);
    
    // Create WebSocket with options
    signalkWs = new WebSocket(wsUrl);
    
    // Log connection attempt
    console.log('WebSocket connection attempt started');
    
    signalkWs.on('open', () => {
      console.log('Connected to SignalK WebSocket');
      wsConnected = true;
      
      // Log WebSocket state
      console.log('WebSocket state after connection:', {
        readyState: signalkWs.readyState,
        bufferedAmount: signalkWs.bufferedAmount,
        url: signalkWs.url
      });
      
      // Wait a moment to ensure WebSocket is fully ready
      setTimeout(() => {
        // Check readyState before sending
        if (signalkWs.readyState === WebSocket.OPEN) {
          // Subscribe to self data
          // Create metadata for mastAngle path - use a format compatible with SignalK server
          const metadataMsg = {
            context: 'vessels.self',
            updates: [
              {
                source: {
                  label: 'pgn-monitor',
                  type: 'CAN'
                },
                meta: [
                  {
                    path: 'sailing.mastAngle',
                    value: {
                      units: 'rad',
                      description: 'Mast rotation angle correction (difference between boat heading and mast heading)',
                      displayName: 'Mast Angle'
                    }
                  }
                ]
              }
            ]
          };
          
          // Send metadata message
          try {
            const metadataJson = JSON.stringify(metadataMsg);
            console.log('Sending metadata message:', metadataJson);
            
            // Use a safer send method with error handling
            if (signalkWs && signalkWs.readyState === WebSocket.OPEN) {
              // Use a simple string send to avoid any mask function issues
              signalkWs.send(metadataJson);
              console.log('Sent metadata for mastAngle path');
            } else {
              console.error('WebSocket not ready for sending metadata');
            }
          } catch (error) {
            console.error('Error sending metadata:', error.message);
          }
          
          // Subscribe to relevant paths - use a more compatible format
          const subscriptionMsg = {
            context: 'vessels.self',
            subscribe: [
              {
                path: 'environment.wind.*',
                period: 1000,
                format: 'delta',
                policy: 'instant'
              },
              {
                path: 'navigation.headingMagnetic',
                period: 1000,
                format: 'delta',
                policy: 'instant'
              }
            ]
          };
          
          try {
            const subscriptionJson = JSON.stringify(subscriptionMsg);
            console.log('Sending subscription message:', subscriptionJson);
            
            // Use a safer send method with error handling
            if (signalkWs && signalkWs.readyState === WebSocket.OPEN) {
              // Use a simple string send to avoid any mask function issues
              signalkWs.send(subscriptionJson);
              console.log('Subscribed to SignalK wind data');
            } else {
              console.error('WebSocket not ready for sending subscription');
            }
          } catch (error) {
            console.error('Error sending subscription:', error.message);
          }
          
          // Send a test update to verify connection
          setTimeout(() => {
            if (wsConnected && signalkWs.readyState === WebSocket.OPEN) {
              console.log('Sending test update to SignalK...');
              const testUpdate = {
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
                        path: 'environment.wind.angleApparent',
                        value: 0
                      }
                    ]
                  }
                ]
              };
              try {
                const testUpdateJson = JSON.stringify(testUpdate);
                
                // Use a safer send method with error handling
                if (signalkWs && signalkWs.readyState === WebSocket.OPEN) {
                  // Use a simple string send to avoid any mask function issues
                  signalkWs.send(testUpdateJson);
                  console.log('Sent test update to SignalK');
                } else {
                  console.error('WebSocket not ready for sending test update');
                }
              } catch (error) {
                console.error('Error sending test update:', error.message);
              }
            }
          }, 2000);
        } else {
          console.error(`WebSocket not ready: readyState ${signalkWs.readyState}`);
        }
      }, 1000); // Wait 1 second before sending any messages
    });
    
    signalkWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        
        // Process pypilot updates
        if (msg.updates && Array.isArray(msg.updates)) {
          for (const update of msg.updates) {
            // Check if this is a pypilot source update
            if (update.$source === 'pypilot') {
              processPypilotData(update);
            }
          }
        }
        
        if (VERBOSE) {
          console.log('Received SignalK data:', JSON.stringify(msg, null, 2));
        }
      } catch (error) {
        console.error('Error parsing SignalK message:', error);
      }
    });
    
    signalkWs.on('error', (error) => {
      console.error(`SignalK WebSocket error: ${error.message}`);
      console.error('Error details:', error);
      wsConnected = false;
    });
    
    signalkWs.on('close', () => {
      console.log('SignalK WebSocket connection closed');
      wsConnected = false;
      
      // Try to reconnect after a delay
      setTimeout(() => {
        if (!wsConnected) {
          console.log('Attempting to reconnect to SignalK...');
          connectToSignalK();
        }
      }, 5000);
    });
  } catch (error) {
    console.error(`Error connecting to SignalK: ${error.message}`);
    wsConnected = false;
    
    // Try to reconnect after a delay
    setTimeout(() => {
      if (!wsConnected) {
        console.log('Attempting to reconnect to SignalK...');
        connectToSignalK();
      }
    }, 5000);
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

// Function to send wind data to SignalK server
async function forwardWindData(pgn) {
  try {
    // Create a new PGN message with required fields
    const fields = {
      sid: pgn.fields.sid || 0,
      windSpeed: pgn.fields.windSpeed || 0,
      windAngle: (toggleCorrect && outputAWA) ? outputAWA : (pgn.fields.windAngle || 0),  // Use corrected wind angle if toggle is on and available
      reference: pgn.fields.reference || 'Apparent'
    };
    
    if (DEBUG) {
      console.log('Creating SignalK update with fields:', fields);
    } else {
      // console.log(`Updating wind data: AWA=${fields.windAngle.toFixed(2)} rad, AWS=${fields.windSpeed.toFixed(2)} m/s`);
    }
    
    if (!wsConnected || !signalkWs || signalkWs.readyState !== WebSocket.OPEN) {
      console.log('WebSocket not connected or not ready, attempting to reconnect...');
      connectToSignalK();
      return;
    }
    
    // Create a combined delta format update for angle, speed, and mast angle
    const deltaUpdate = {
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
              path: 'environment.wind.angleApparent',
              value: fields.windAngle
            },
            {
              path: 'environment.wind.speedApparent',
              value: fields.windSpeed
            },
            {
              path: 'environment.wind.angleApparentRaw',
              value: inputAWA !== null ? inputAWA : 0
            }
          ]
        }
      ]
    };
    
    // Always include mastAngle in updates if available
    if (mastAngle !== null) {
      // Add mastAngle to the same update
      deltaUpdate.updates[0].values.push({
        path: 'sailing.mastAngle',
        value: mapAngleToDisplayRange(mastAngle)
      });
      
      // Update timestamp of last mastAngle update
      lastMastAngleUpdate = Date.now();
      // console.log(`Including mastAngle in wind update: ${mapAngleToDisplayRange(mastAngle).toFixed(4)} rad (mapped from ${mastAngle.toFixed(4)} rad)`);
    }
    
    const deltaJson = JSON.stringify(deltaUpdate);
    
    // Log the delta format
    if (DEBUG) {
      console.log('Using delta format for updates:');
      console.log(JSON.stringify(deltaUpdate, null, 2));
    }
    
    // Always log in verbose mode
    if (VERBOSE) {
      console.log('Sending delta update to SignalK via WebSocket:', deltaJson);
    }
    
    // In debug mode, dump more details
    if (DEBUG) {
      console.log('WebSocket readyState:', signalkWs.readyState);
      console.log('WebSocket bufferedAmount:', signalkWs.bufferedAmount);
    }
    
    // Send the delta update with error handling
    try {
      // Make sure we're sending a string, not an object
      if (typeof deltaJson === 'string') {
        signalkWs.send(deltaJson);
      } else {
        // If somehow deltaJson is not a string, stringify it again
        signalkWs.send(JSON.stringify(deltaUpdate));
      }
      // console.log(`Sent delta update to SignalK with ${deltaUpdate.updates[0].values.length} values`);
    } catch (error) {
      console.error(`Error sending update: ${error.message}`);
      // Don't try to reconnect immediately, just mark as disconnected
      wsConnected = false;
      // Schedule reconnection attempt
      setTimeout(() => {
        if (!wsConnected) {
          connectToSignalK();
        }
      }, 1000);
      return;
    }
    
    // Log the paths we're updating
    if (DEBUG) {
      console.log('SignalK update paths:');
      console.log('- environment.wind.angleApparent');
      console.log('- environment.wind.speedApparent');
      console.log('- sailing.mastAngle (mast rotation angle correction)');
    }
    
    if (VERBOSE) {
      console.log('Forwarded wind data to SignalK server via WebSocket');
    }
  } catch (error) {
    console.error(`Error forwarding wind data: ${error.message}`);
    console.error(error.stack);
    
    // Check if the error is related to WebSocket connection
    if (error.message.includes('WebSocket') || error.message.includes('ECONNREFUSED') ||
        error.message.includes('not open') || !wsConnected) {
      console.log('WebSocket connection issue detected, attempting to reconnect...');
      wsConnected = false;
      // Try to reconnect
      setTimeout(() => {
        if (!wsConnected) {
          connectToSignalK();
        }
      }, 1000); // Try to reconnect after 1 second
    }
  }
}

// Function to process pypilot data from SignalK
function processPypilotData(update) {
  if (!update.values || !Array.isArray(update.values)) {
    return;
  }
  
  for (const value of update.values) {
    if (value.path === 'navigation.headingMagnetic' && value.value !== undefined) {
      boatHeading = value.value;
      // console.log(`Pypilot: Updated Heading - ${boatHeading} rad`);
      
      // Update mastAngle whenever boatHeading changes and we have canHeading
      if (canHeading !== null) {
        updateMastAngle();
      }
      
      // Recalculate outputAWA if we have all the necessary data
      if (canHeading !== null && inputAWA !== null) {
        outputAWA = normalizeAngle(inputAWA + mastAngle);
        // console.log(`Recalculated Output AWA: ${outputAWA.toFixed(4)} rad based on offset-adjusted Mast Angle: ${mastAngle.toFixed(4)} rad`);
      }
    }
  }
}

// Initialize the application
async function initialize() {
  try {
    console.log('Initializing PGN Monitor...');
    
    // Try to load saved token
    authToken = await loadToken();
    
    // If no token, request one
    if (authToken) {
      authToken = authToken;
    } else {
      await requestAccessToken();
    }
    
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
    
    // Connect to SignalK with the token
    if (authToken) {
      connectToSignalK();
    }
    
    // Start the CAN channel
    windChannel.start();
    console.log(`Monitoring Wind Data (PGN 130306) on ${windCanDevice}`);
    console.log(`Monitoring Vessel Heading (PGN 127250) on ${windCanDevice}`);
    console.log(`Monitoring Pypilot data from SignalK server at ${skServer}:${skPort}`);
    console.log(`Forwarding Corrected Wind Data from ${windCanDevice} to SignalK server at ${skServer}:${skPort}`);
    console.log(`Debug mode: ${DEBUG ? 'enabled' : 'disabled'} (use --debug to enable)`);
    console.log(`Verbose mode: ${VERBOSE ? 'enabled' : 'disabled'} (use --verbose to enable)`);
    
    // Add diagnostic information
    console.log('Diagnostic information:');
    console.log(`- Node.js version: ${process.version}`);
    console.log(`- Platform: ${process.platform}`);
    console.log(`- Auth token available: ${authToken ? 'Yes' : 'No'}`);
    console.log(`- WebSocket connected: ${wsConnected ? 'Yes' : 'No'}`);
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
  console.log(`boatHeading: ${radToDegree(boatHeading).toFixed(1)} mastHeading: ${radToDegree(canHeading).toFixed(1)} Updated Mast Angle: ${mastAngle.toFixed(4)} rad (display: ${displayMastAngle.toFixed(4)} rad / ${radToDegree(displayMastAngle).toFixed(1)}°)`);
  
  // Send a dedicated update for mastAngle
  const now = Date.now();
  // Only send if it's been more than 100ms since last update to avoid flooding
  if ((now - lastMastAngleUpdate > 100) && wsConnected && signalkWs && signalkWs.readyState === WebSocket.OPEN) {
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