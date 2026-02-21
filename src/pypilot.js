/**
 * PyPilot Connection Module
 * Handles connections to pypilot instances for heading data
 */

const net = require('net');

// Module state
let mastClient = null;
let boatClient = null;
let mastHeading = null;
let boatHeading = null;

// Configuration
let mastHost = '10.1.1.1';
let boatHost = 'localhost';
let pypilotPort = 23322;
let DEBUG = false;
let VERBOSE = false;

// Callbacks
let onMastHeadingUpdate = null;
let onBoatHeadingUpdate = null;
let onConnectionStatusChange = null;

/**
 * Initialize the pypilot module
 */
function init(config) {
  mastHost = config.mastHost || '10.1.1.1';
  boatHost = config.boatHost || 'localhost';
  pypilotPort = config.pypilotPort || 23322;
  DEBUG = config.debug || false;
  VERBOSE = config.verbose || false;
  onMastHeadingUpdate = config.onMastHeadingUpdate || null;
  onBoatHeadingUpdate = config.onBoatHeadingUpdate || null;
  onConnectionStatusChange = config.onConnectionStatusChange || null;
}

/**
 * Connect to mast pypilot
 */
function connectToMast() {
  if (mastClient) {
    try {
      mastClient.destroy();
    } catch (e) {
      // Ignore errors
    }
  }

  console.log(`Connecting to mast pypilot at ${mastHost}:${pypilotPort}`);
  
  mastClient = net.createConnection({ 
    host: mastHost, 
    port: pypilotPort,
    timeout: 10000  // 10 second connection timeout
  }, () => {
    console.log('Connected to mast pypilot, requesting heading data...');
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('mast', true);
    }
    
    // Watch for heading updates
    const watchCmd = 'watch={"ap.heading":true}\n';
    console.log(`Sending watch command to mast pypilot: ${watchCmd.trim()}`);
    mastClient.write(watchCmd);
    
    // Set a timeout to check if we're receiving data
    setTimeout(() => {
      if (mastHeading === null) {
        console.log('WARNING: No heading data received from mast pypilot after 5 seconds');
        console.log('Try manually: nc ' + mastHost + ' ' + pypilotPort);
        console.log('Then type: watch={"ap.heading":true}');
      }
    }, 5000);
  });

  let buffer = '';
  
  mastClient.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || '';
    
    lines.forEach((line) => {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          
          // Magnetic heading in degrees
          if (msg['ap.heading'] !== undefined) {
            const headingDegrees = msg['ap.heading'];
            // Convert to radians
            const headingRadians = headingDegrees * Math.PI / 180;
            mastHeading = headingRadians;
            
            console.log(`Mast Heading: ${headingDegrees.toFixed(1)}° (${headingRadians.toFixed(4)} rad)`);
            
            if (onMastHeadingUpdate) {
              onMastHeadingUpdate(headingRadians);
            }
          }
        } catch (e) {
          // Try parsing key=value format
          const match = line.match(/ap\.heading=([\d.-]+)/);
          if (match) {
            const headingDegrees = parseFloat(match[1]);
            const headingRadians = headingDegrees * Math.PI / 180;
            mastHeading = headingRadians;
            
            if (DEBUG || VERBOSE) {
              console.log(`Mast Heading: ${headingDegrees.toFixed(1)}° (${headingRadians.toFixed(4)} rad)`);
            }
            
            if (onMastHeadingUpdate) {
              onMastHeadingUpdate(headingRadians);
            }
          } else if (DEBUG || VERBOSE) {
            console.log(`Mast pypilot: ${line}`);
          }
        }
      }
    });
  });

  mastClient.on('timeout', () => {
    console.error(`Mast pypilot connection timeout after 10 seconds`);
    mastClient.destroy();
  });

  mastClient.on('error', (err) => {
    console.error(`Mast pypilot connection error: ${err.message}`);
    console.error(`Error code: ${err.code}`);
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('mast', false);
    }
  });

  mastClient.on('close', () => {
    console.log('Mast pypilot connection closed');
    mastClient = null;
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('mast', false);
    }
    
    // Reconnect after delay
    setTimeout(() => {
      console.log('Attempting to reconnect to mast pypilot...');
      connectToMast();
    }, 5000);
  });
}

/**
 * Connect to boat pypilot
 */
function connectToBoat() {
  if (boatClient) {
    try {
      boatClient.destroy();
    } catch (e) {
      // Ignore errors
    }
  }

  console.log(`Connecting to boat pypilot at ${boatHost}:${pypilotPort}`);
  
  boatClient = net.createConnection({ host: boatHost, port: pypilotPort }, () => {
    console.log('Connected to boat pypilot, requesting heading data...');
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('boat', true);
    }
    
    // Watch for heading updates
    const watchCmd = 'watch={"ap.heading":true}\n';
    console.log(`Sending watch command to boat pypilot: ${watchCmd.trim()}`);
    boatClient.write(watchCmd);
    
    // Set a timeout to check if we're receiving data
    setTimeout(() => {
      if (boatHeading === null) {
        console.log('WARNING: No heading data received from boat pypilot after 5 seconds');
        console.log('Try manually: nc ' + boatHost + ' ' + pypilotPort);
        console.log('Then type: watch={"ap.heading":true}');
      }
    }, 5000);
  });

  let buffer = '';
  
  boatClient.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || '';
    
    lines.forEach((line) => {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          
          // Magnetic heading in degrees
          if (msg['ap.heading'] !== undefined) {
            const headingDegrees = msg['ap.heading'];
            // Convert to radians
            const headingRadians = headingDegrees * Math.PI / 180;
            boatHeading = headingRadians;
            
            console.log(`Boat Heading: ${headingDegrees.toFixed(1)}° (${headingRadians.toFixed(4)} rad)`);
            
            if (onBoatHeadingUpdate) {
              onBoatHeadingUpdate(headingRadians);
            }
          }
        } catch (e) {
          // Try parsing key=value format
          const match = line.match(/ap\.heading=([\d.-]+)/);
          if (match) {
            const headingDegrees = parseFloat(match[1]);
            const headingRadians = headingDegrees * Math.PI / 180;
            boatHeading = headingRadians;
            
            if (DEBUG || VERBOSE) {
              console.log(`Boat Heading: ${headingDegrees.toFixed(1)}° (${headingRadians.toFixed(4)} rad)`);
            }
            
            if (onBoatHeadingUpdate) {
              onBoatHeadingUpdate(headingRadians);
            }
          } else if (DEBUG || VERBOSE) {
            console.log(`Boat pypilot: ${line}`);
          }
        }
      }
    });
  });

  boatClient.on('error', (err) => {
    console.error(`Boat pypilot connection error: ${err.message}`);
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('boat', false);
    }
  });

  boatClient.on('close', () => {
    console.log('Boat pypilot connection closed');
    boatClient = null;
    
    if (onConnectionStatusChange) {
      onConnectionStatusChange('boat', false);
    }
    
    // Reconnect after delay
    setTimeout(() => {
      console.log('Attempting to reconnect to boat pypilot...');
      connectToBoat();
    }, 5000);
  });
}

/**
 * Start pypilot connections
 */
function start() {
  connectToMast();
  connectToBoat();
}

/**
 * Stop pypilot connections
 */
function stop() {
  if (mastClient) {
    mastClient.destroy();
    mastClient = null;
  }
  
  if (boatClient) {
    boatClient.destroy();
    boatClient = null;
  }
}

/**
 * Get current headings
 */
function getHeadings() {
  return {
    mast: mastHeading,
    boat: boatHeading
  };
}

/**
 * Check if connected
 */
function isConnected() {
  return {
    mast: mastClient !== null && !mastClient.destroyed,
    boat: boatClient !== null && !boatClient.destroyed
  };
}

module.exports = {
  init,
  start,
  stop,
  getHeadings,
  isConnected
};
