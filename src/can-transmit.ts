import { toPgn } from '@canboat/canboatjs'
import * as socketcan from 'socketcan'

interface CanTransmitConfig {
  device: string
  debug: boolean
  onError?: (error: string) => void
  onStatusChange?: (connected: boolean) => void
}

let canChannel: any = null
let canDevice: string = ''
let DEBUG: boolean = false
let lastAWA: number | null = null
let lastAWS: number | null = null
let transmitCount: number = 0
let errorCount: number = 0
let onError: ((error: string) => void) | undefined
let onStatusChange: ((connected: boolean) => void) | undefined

export function initCanTransmit(config: CanTransmitConfig): boolean {
  try {
    canDevice = config.device
    DEBUG = config.debug
    onError = config.onError
    onStatusChange = config.onStatusChange

    console.log(`Initializing CAN transmit on ${canDevice}`)

    canChannel = socketcan.createRawChannel(canDevice)

    canChannel.addListener('onStopped', (msg: string) => {
      console.error(`CAN transmit channel stopped: ${msg}`)
      if (onStatusChange) {
        onStatusChange(false)
      }
    })

    canChannel.start()
    console.log(`CAN transmit channel started on ${canDevice}`)
    
    if (onStatusChange) {
      onStatusChange(true)
    }

    return true
  } catch (error) {
    const errorMsg = `Failed to initialize CAN transmit: ${error instanceof Error ? error.message : String(error)}`
    console.error(errorMsg)
    if (onError) {
      onError(errorMsg)
    }
    return false
  }
}

export function transmitHeading(headingRadians: number): boolean {
  try {
    if (!canChannel) {
      if (DEBUG) console.error('CAN channel not initialized')
      return false
    }

    const pgnData = {
      pgn: 127250,
      'Heading': headingRadians,
      'Reference': 'Magnetic'
    }

    const canData = toPgn(pgnData)
    if (!canData) {
      console.error('Failed to generate CAN data from PGN 127250')
      errorCount++
      return false
    }

    const dataBuffer = Buffer.isBuffer(canData) ? canData : Buffer.from(canData)
    const priority = 2
    const pgn = 127250
    const source = 255
    const canId = (priority << 26) | (pgn << 8) | source

    canChannel.send({ id: canId, data: dataBuffer, ext: true })
    transmitCount++

    if (DEBUG) {
      console.log(`Transmitted PGN 127250: Heading=${(headingRadians * 180 / Math.PI).toFixed(1)}°`)
    }

    return true
  } catch (error) {
    const errorMsg = `Error transmitting heading: ${error instanceof Error ? error.message : String(error)}`
    console.error(errorMsg)
    errorCount++
    if (onError) onError(errorMsg)
    return false
  }
}

export function transmitWindData(awa: number, aws: number): boolean {
  try {
    if (!canChannel) {
      if (DEBUG) {
        console.error('CAN channel not initialized')
      }
      return false
    }

    if (awa === null || awa === undefined || aws === null || aws === undefined) {
      if (DEBUG) {
        console.error('Invalid wind data: AWA or AWS is null/undefined')
      }
      return false
    }

    if (awa < 0 || awa >= 2 * Math.PI) {
      if (DEBUG) {
        console.error(`Invalid AWA value: ${awa} (must be 0 to 2π)`)
      }
      return false
    }

    if (aws < 0) {
      if (DEBUG) {
        console.error(`Invalid AWS value: ${aws} (must be >= 0)`)
      }
      return false
    }

    lastAWA = awa
    lastAWS = aws

    const pgnData = {
      pgn: 130306,
      'Wind Speed': aws,
      'Wind Angle': awa,
      'Reference': 'Apparent'
    }

    const canData = toPgn(pgnData)

    if (!canData) {
      console.error('Failed to generate CAN data from PGN')
      errorCount++
      return false
    }

    if (DEBUG) {
      console.log('toPgn returned:', canData)
      console.log('Type:', typeof canData, 'IsBuffer:', Buffer.isBuffer(canData), 'IsArray:', Array.isArray(canData))
    }

    // toPgn returns a Buffer or array of bytes, we need to construct the CAN message
    const dataBuffer = Buffer.isBuffer(canData) ? canData : Buffer.from(canData)
    
    // Construct CAN ID for PGN 130306
    // Priority: 2, PGN: 130306 (0x1FD02), Source: 255, Destination: 255
    const priority = 2
    const pgn = 130306
    const source = 255
    const canId = (priority << 26) | (pgn << 8) | source

    canChannel.send({
      id: canId,
      data: dataBuffer,
      ext: true
    })

    transmitCount++

    if (DEBUG) {
      const awaDegrees = (awa * 180 / Math.PI).toFixed(1)
      console.log(`Transmitted PGN 130306: AWA=${awaDegrees}°, AWS=${aws.toFixed(2)} m/s (count: ${transmitCount})`)
    }

    return true
  } catch (error) {
    const errorMsg = `Error transmitting wind data: ${error instanceof Error ? error.message : String(error)}`
    console.error(errorMsg)
    errorCount++
    if (onError) {
      onError(errorMsg)
    }
    return false
  }
}

export function transmitHeading(headingRadians: number): boolean {
  try {
    if (!canChannel) {
      if (DEBUG) console.error('CAN channel not initialized')
      return false
    }

    const pgnData = {
      pgn: 127250,
      'Heading': headingRadians,
      'Reference': 'Magnetic'
    }

    const canData = toPgn(pgnData)
    if (!canData) {
      console.error('Failed to generate CAN data from PGN 127250')
      errorCount++
      return false
    }

    const dataBuffer = Buffer.isBuffer(canData) ? canData : Buffer.from(canData)
    const priority = 2
    const pgn = 127250
    const source = 255
    const canId = (priority << 26) | (pgn << 8) | source

    canChannel.send({ id: canId, data: dataBuffer, ext: true })
    transmitCount++

    if (DEBUG) {
      console.log(`Transmitted PGN 127250: Heading=${(headingRadians * 180 / Math.PI).toFixed(1)}°`)
    }

    return true
  } catch (error) {
    const errorMsg = `Error transmitting heading: ${error instanceof Error ? error.message : String(error)}`
    console.error(errorMsg)
    errorCount++
    if (onError) onError(errorMsg)
    return false
  }
}

export function stopCanTransmit(): void {
  try {
    if (canChannel) {
      console.log('Stopping CAN transmit channel')
      canChannel.stop()
      canChannel = null
      if (onStatusChange) {
        onStatusChange(false)
      }
    }
  } catch (error) {
    console.error(`Error stopping CAN transmit: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function isCanReady(): boolean {
  return canChannel !== null
}

export function getStats() {
  return {
    transmitCount,
    errorCount,
    lastAWA,
    lastAWS,
    device: canDevice,
    ready: isCanReady()
  }
}
