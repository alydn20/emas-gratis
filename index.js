// index.js - VERSI GRATIS (Update setiap 10 menit)
// Untuk versi premium (real-time), hubungi: 08xxxxxxxxxx
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'

// ------ CONFIG ------
const PORT = process.env.PORT || 8000
const TREASURY_URL = process.env.TREASURY_URL ||
  'https://api.treasury.id/api/v1/antigrvty/gold/rate'

// 🆓 VERSI GRATIS: Delay 10 menit
const CONTACT_PREMIUM = '6289654454210' // Nomor untuk versi premium

// Anti-spam settings
const COOLDOWN_PER_CHAT = 60000
const GLOBAL_THROTTLE = 3000
const TYPING_DURATION = 2000

// 🆓 BROADCAST COOLDOWN - 1 JAM untuk versi gratis (setiap jam xx:01)
const PRICE_CHECK_INTERVAL = 60000 // Cek setiap 1 menit
const MIN_PRICE_CHANGE = 1
const BROADCAST_COOLDOWN = 3600000 // 1 JAM antar broadcast

// Economic Calendar Settings
const ECONOMIC_CALENDAR_ENABLED = true
const CALENDAR_COUNTRY_FILTER = ['USD']
const CALENDAR_MIN_IMPACT = 3

// Broadcast Settings
const BATCH_SIZE = 20
const BATCH_DELAY = 1000

// Konversi troy ounce ke gram
const TROY_OZ_TO_GRAM = 31.1034768

// Threshold untuk harga normal/abnormal
const NORMAL_THRESHOLD = 2000
const NORMAL_LOW_THRESHOLD = 1000

// Cache untuk XAU/USD
let cachedXAUUSD = null
let lastXAUUSDFetch = 0
const XAU_CACHE_DURATION = 60000 // 1 menit cache

// Cache untuk Economic Calendar
let cachedEconomicEvents = null
let lastEconomicFetch = 0
const ECONOMIC_CACHE_DURATION = 300000 // 5 menit

let lastKnownPrice = null
let lastBroadcastedPrice = null
let isBroadcasting = false
let broadcastCount = 0
let lastBroadcastTime = 0

// Stale price detection
let lastPriceUpdateTime = 0
const STALE_PRICE_THRESHOLD = 10 * 60 * 1000 // 10 menit untuk versi gratis

// Reconnect settings
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY = 5000

// ------ STATE ------
let lastQr = null
const logs = []
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0
let isReady = false
let sock = null

const subscriptions = new Set()

// Cache global untuk market data
let cachedMarketData = {
  usdIdr: null,
  xauUsd: null,
  economicEvents: null,
  lastUpdate: 0,
  lastUsdIdrFetch: 0
}

// Background task - update setiap 1 menit untuk versi gratis
setInterval(async () => {
  try {
    const now = Date.now()
    const currentMinute = Math.floor(now / 60000)
    const lastFetchMinute = Math.floor(cachedMarketData.lastUsdIdrFetch / 60000)

    let usdIdr = cachedMarketData.usdIdr;
    if (currentMinute !== lastFetchMinute || cachedMarketData.lastUsdIdrFetch === 0) {
      try {
        const newUsdIdr = await fetchUSDIDRFromGoogle();
        if (newUsdIdr && newUsdIdr.rate) {
          usdIdr = newUsdIdr;
          cachedMarketData.lastUsdIdrFetch = now
          console.log(`[Cache] USD/IDR updated: Rp ${usdIdr.rate.toLocaleString('id-ID')}`)
        }
      } catch (e) {
        console.log(`[Cache] USD/IDR error, keeping old value`)
      }
    }

    const [xauUsd, economicEvents] = await Promise.all([
      fetchXAUUSDCached(),
      fetchEconomicCalendar()
    ]);

    cachedMarketData = {
      ...cachedMarketData,
      usdIdr,
      xauUsd,
      economicEvents,
      lastUpdate: now
    }
  } catch (e) {
    // Silent fail
  }
}, 60000) // Update setiap 1 menit

function pushLog(s) {
  const logMsg = `${new Date().toISOString().substring(11, 19)} ${s}`
  logs.push(logMsg)
  if (logs.length > 30) logs.shift()
  console.log(logMsg)
}

setInterval(() => {
  if (processedMsgIds.size > 300) {
    const arr = Array.from(processedMsgIds).slice(-200)
    processedMsgIds.clear()
    arr.forEach(id => processedMsgIds.add(id))
  }
}, 5 * 60 * 1000)

// ------ UTIL ------
function normalizeText(msg) {
  if (!msg) return ''
  return msg.replace(/\s+/g, ' ').trim().toLowerCase()
}

function shouldIgnoreMessage(m) {
  if (!m || !m.key) return true
  if (m.key.remoteJid === 'status@broadcast') return true
  if (m.key.fromMe) return true

  const hasText =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption
  if (!hasText) return true

  return false
}

function extractText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    ''
  )
}

function formatRupiah(n) {
  return typeof n === 'number'
    ? n.toLocaleString('id-ID')
    : (Number(n || 0) || 0).toLocaleString('id-ID')
}

function calculateDiscount(investmentAmount) {
  const MAX_DISCOUNT = 1020000

  let discountPercent

  if (investmentAmount <= 250000) {
    discountPercent = 3.0
  } else if (investmentAmount <= 5000000) {
    discountPercent = 3.4
  } else if (investmentAmount <= 10000000) {
    discountPercent = 3.45
  } else if (investmentAmount <= 20000000) {
    discountPercent = 3.425
  } else {
    discountPercent = 3.4
  }

  const calculatedDiscount = investmentAmount * (discountPercent / 100)
  return Math.min(calculatedDiscount, MAX_DISCOUNT)
}

function calculateProfit(buyRate, sellRate, investmentAmount) {
  const discountAmount = calculateDiscount(investmentAmount)
  const discountedPrice = investmentAmount - discountAmount
  const totalGrams = investmentAmount / buyRate
  const sellValue = totalGrams * sellRate
  const totalProfit = sellValue - discountedPrice

  return {
    discountedPrice,
    totalGrams,
    profit: totalProfit
  }
}

// ------ ECONOMIC CALENDAR FUNCTIONS ------
async function fetchEconomicCalendar() {
  if (!ECONOMIC_CALENDAR_ENABLED) return null

  const now = Date.now()

  if (cachedEconomicEvents && (now - lastEconomicFetch) < ECONOMIC_CACHE_DURATION) {
    return cachedEconomicEvents
  }

  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: AbortSignal.timeout(5000)
    })

    if (!res.ok) {
      return null
    }

    const events = await res.json()

    const jakartaNow = new Date(Date.now() + (7 * 60 * 60 * 1000))
    const todayJakarta = new Date(jakartaNow.getFullYear(), jakartaNow.getMonth(), jakartaNow.getDate())
    const tomorrowJakarta = new Date(todayJakarta.getTime() + (24 * 60 * 60 * 1000))
    const dayAfterTomorrowJakarta = new Date(todayJakarta.getTime() + (2 * 24 * 60 * 60 * 1000))

    const filteredEvents = events.filter(event => {
      if (!event.date) return false

      const eventDate = new Date(event.date)
      const eventWIB = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))
      const eventDateOnly = new Date(eventWIB.getFullYear(), eventWIB.getMonth(), eventWIB.getDate())

      const threeHoursAfterEvent = new Date(eventDate.getTime() + (3 * 60 * 60 * 1000))

      if (Date.now() > threeHoursAfterEvent.getTime()) {
        return false
      }

      if (eventDateOnly < todayJakarta || eventDateOnly >= dayAfterTomorrowJakarta) {
        return false
      }

      if (!CALENDAR_COUNTRY_FILTER.includes(event.country)) return false
      if (event.impact !== 'High') return false

      return true
    })

    filteredEvents.sort((a, b) => {
      const timeA = new Date(a.date).getTime()
      const timeB = new Date(b.date).getTime()
      return timeA - timeB
    })

    const limitedEvents = filteredEvents.slice(0, 10)

    pushLog(`📅 Found ${limitedEvents.length} USD high-impact events`)

    cachedEconomicEvents = limitedEvents
    lastEconomicFetch = now

    return limitedEvents

  } catch (e) {
    return null
  }
}

function analyzeGoldImpact(event) {
  const title = (event.title || '').toLowerCase()
  const actual = event.actual || ''
  const forecast = event.forecast || ''

  if (!actual || actual === '-' || !forecast || forecast === '-') {
    return null
  }

  const actualNum = parseFloat(actual.replace(/[^0-9.-]/g, ''))
  const forecastNum = parseFloat(forecast.replace(/[^0-9.-]/g, ''))

  if (isNaN(actualNum) || isNaN(forecastNum)) {
    return null
  }

  if (title.includes('interest rate') || title.includes('fed') || title.includes('fomc')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }

  if (title.includes('non-farm') || title.includes('nfp') || title.includes('payroll')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }

  if (title.includes('unemployment')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }

  if (title.includes('cpi') || title.includes('inflation') || title.includes('pce')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }

  if (title.includes('gdp')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }

  if (title.includes('jobless') || title.includes('claims')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }

  if (title.includes('retail sales')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }

  return null
}

function formatEconomicCalendar(events) {
  if (!events || events.length === 0) {
    return ''
  }

  let calendarText = '\n📅 USD News\n'

  events.forEach((event, index) => {
    const eventDate = new Date(event.date)
    const wibTime = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))

    const minutes = wibTime.getMinutes()
    const roundedMinutes = Math.round(minutes / 5) * 5
    wibTime.setMinutes(roundedMinutes)
    wibTime.setSeconds(0)

    const hours = wibTime.getHours().toString().padStart(2, '0')
    const mins = wibTime.getMinutes().toString().padStart(2, '0')
    const timeStr = `${hours}:${mins}`

    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const dayName = days[wibTime.getDay()]

    const title = event.title || event.event || 'Unknown Event'
    const forecast = event.forecast || '-'
    const actual = event.actual || '-'

    const nowTime = Date.now()
    const eventTime = eventDate.getTime()
    const timeSinceEvent = nowTime - eventTime
    const minutesSinceEvent = Math.floor(timeSinceEvent / (60 * 1000))

    let timeStatus = ''
    if (timeSinceEvent < 0) {
      const minutesUntil = Math.abs(minutesSinceEvent)
      if (minutesUntil < 60) {
        timeStatus = `⏰${minutesUntil}m`
      } else {
        const hoursUntil = Math.floor(minutesUntil / 60)
        const minsUntil = minutesUntil % 60
        if (minsUntil > 0) {
          timeStatus = `⏰${hoursUntil}j ${minsUntil}m`
        } else {
          timeStatus = `⏰${hoursUntil}j`
        }
      }
    } else if (timeSinceEvent > 0 && timeSinceEvent <= 3 * 60 * 60 * 1000) {
      const hoursAgo = Math.floor(minutesSinceEvent / 60)
      const minsAgo = minutesSinceEvent % 60
      if (hoursAgo > 0) {
        timeStatus = `✅${hoursAgo}j ${minsAgo}m lalu`
      } else {
        timeStatus = `✅${minsAgo}m lalu`
      }
    }

    let shortTitle = title
    if (title.includes('Non-Farm')) shortTitle = 'NFP'
    else if (title.includes('Unemployment')) shortTitle = 'Unemp'
    else if (title.includes('Interest Rate')) shortTitle = 'Interest'
    else if (title.includes('CPI')) shortTitle = 'CPI'
    else if (title.includes('GDP')) shortTitle = 'GDP'
    else if (title.includes('Retail')) shortTitle = 'Retail'
    else if (title.includes('Jobless')) shortTitle = 'Jobless'

    calendarText += `• ${dayName} ${timeStr}`

    if (timeStatus) {
      calendarText += ` (${timeStatus})`
    }

    calendarText += ` ${shortTitle}`

    if (actual !== '-' && actual !== '') {
      const goldImpact = analyzeGoldImpact(event)

      calendarText += ` ${actual}>${forecast}`

      if (goldImpact === 'BAGUS') {
        calendarText += ` 🟢 BAGUS`
      } else if (goldImpact === 'JELEK') {
        calendarText += ` 🔴 JELEK`
      }
    } else if (forecast !== '-') {
      calendarText += ` F:${forecast}`
    }

    calendarText += '\n'
  })

  return calendarText
}

// ------ FOREX FUNCTIONS ------
async function fetchUSDIDRFromGoogle() {
  const maxRetries = 3
  let attempt = 0

  while (attempt < maxRetries) {
    attempt++

    try {
      if (attempt === 1) {
        console.log(`[USD/IDR] Fetching from Google Finance...`)
      }

      const res = await fetch('https://www.google.com/finance/quote/USD-IDR', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        },
        signal: AbortSignal.timeout(10000)
      })

      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
      }

      const html = await res.text()

      const patterns = [
        /class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i,
        /class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i,
        /data-last-price="([0-9,\.]+)"/i,
        />([0-9]{2}[,\.][0-9]{3}(?:\.[0-9]+)?)</,
      ]

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match?.[1]) {
          const rate = parseFloat(match[1].replace(/,/g, ''))

          if (rate > 15000 && rate < 17000) {
            console.log(`[USD/IDR] Rp ${rate.toLocaleString('id-ID')}`)
            return { rate }
          } else if (rate > 10000 && rate < 20000) {
            console.log(`[USD/IDR] Rp ${rate.toLocaleString('id-ID')} (unusual)`)
            return { rate }
          }
        }
      }

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }

    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  console.log('[USD/IDR] Failed - no data')
  return null
}

async function fetchXAUUSDFromTradingView() {
  try {
    const res = await fetch('https://scanner.tradingview.com/symbol', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        symbols: {
          tickers: ['OANDA:XAUUSD'],
          query: { types: [] }
        },
        columns: ['close']
      }),
      signal: AbortSignal.timeout(5000)
    })

    if (res.ok) {
      const json = await res.json()
      if (json?.data?.[0]?.d) {
        const price = json.data[0].d[0]
        if (price > 1000 && price < 10000) {
          return price
        }
      }
    }
  } catch (e) {}
  return null
}

async function fetchXAUUSDFromGoogle() {
  try {
    const res = await fetch('https://www.google.com/finance/quote/XAU-USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3000)
    })

    if (res.ok) {
      const html = await res.text()
      let priceMatch = html.match(/class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i)
      if (!priceMatch) priceMatch = html.match(/class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i)

      if (priceMatch?.[1]) {
        const price = parseFloat(priceMatch[1].replace(/,/g, ''))
        if (price > 1000 && price < 10000) {
          return price
        }
      }
    }
  } catch (e) {}
  return null
}

async function fetchXAUUSD() {
  let result = await fetchXAUUSDFromTradingView()
  if (result) {
    console.log(`[XAU/USD] $${result.toFixed(2)}`)
    return result
  }

  result = await fetchXAUUSDFromGoogle()
  if (result) {
    console.log(`[XAU/USD] $${result.toFixed(2)}`)
    return result
  }

  console.log('[XAU/USD] Failed - no data')
  return null
}

async function fetchXAUUSDCached() {
  const now = Date.now()

  if (cachedXAUUSD && (now - lastXAUUSDFetch) < XAU_CACHE_DURATION) {
    return cachedXAUUSD
  }

  const price = await fetchXAUUSD()
  if (price) {
    cachedXAUUSD = price
    lastXAUUSDFetch = now
  }

  return cachedXAUUSD
}

function analyzePriceStatus(treasuryBuy, treasurySell, xauUsdPrice, usdIdrRate) {
  if (!xauUsdPrice || !usdIdrRate) {
    return {
      status: 'DATA_INCOMPLETE',
      message: '-',
      emoji: '-'
    }
  }

  const TROY_OZ_TO_GRAM_EXACT = 31.1035
  const MIN_MARGIN = 1.0097
  const MAX_MARGIN = 1.0125

  const basePrice = (xauUsdPrice * usdIdrRate) / TROY_OZ_TO_GRAM_EXACT

  const lowerBound = basePrice * MIN_MARGIN
  const upperBound = basePrice * MAX_MARGIN

  let difference = 0
  let status = 'NORMAL'
  let emoji = '✅'
  let message = '✅ NORMAL'

  if (treasurySell < lowerBound) {
    difference = treasurySell - lowerBound
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (${difference > 0 ? '+' : ''}${formatRupiah(Math.round(difference))})`
  } else if (treasurySell > upperBound) {
    difference = treasurySell - upperBound
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (+${formatRupiah(Math.round(difference))})`
  }

  const actualMargin = ((treasurySell - basePrice) / basePrice) * 100

  return {
    status,
    emoji,
    message,
    basePrice,
    lowerBound,
    upperBound,
    treasuryPrice: treasurySell,
    difference,
    actualMargin
  }
}

function formatMessage(treasuryData, usdIdrRate, xauUsdPrice = null, priceChange = null, economicEvents = null) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0

  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  const buyFormatted = `Rp${formatRupiah(buy)}/gr`
  const sellFormatted = `Rp${formatRupiah(sell)}/gr`

  const updatedAt = treasuryData?.data?.updated_at
  let timeSection = ''
  if (updatedAt) {
    const date = new Date(updatedAt)
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const dayName = days[date.getDay()]
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    timeSection = `${dayName} ${hours}:${minutes}:${seconds} WIB`
  }

  let headerSection = ''
  if (priceChange && priceChange.buyChange !== 0) {
    const changeAmount = Math.abs(priceChange.buyChange)
    const changeFormatted = formatRupiah(changeAmount)
    if (priceChange.buyChange > 0) {
      headerSection = `🚀 🚀 NAIK 🚀 🚀 (+Rp${changeFormatted})\n`
    } else {
      headerSection = `🔻 🔻 TURUN 🔻 🔻 (-Rp${changeFormatted})\n`
    }
  }

  let statusSection = ''
  if (xauUsdPrice && usdIdrRate) {
    const priceStatus = analyzePriceStatus(buy, sell, xauUsdPrice, usdIdrRate)
    statusSection = `\n${priceStatus.message}`
  }

  let marketSection = usdIdrRate
    ? `💱 USD Rp${formatRupiah(Math.round(usdIdrRate))}`
    : `💱 USD -`

  if (xauUsdPrice) {
    marketSection += ` | XAU $${xauUsdPrice.toFixed(2)}`
  }

  const calendarSection = formatEconomicCalendar(economicEvents)

  const grams20M = calculateProfit(buy, sell, 20000000).totalGrams
  const profit20M = calculateProfit(buy, sell, 20000000).profit
  const grams30M = calculateProfit(buy, sell, 30000000).totalGrams
  const profit30M = calculateProfit(buy, sell, 30000000).profit

  const formatGrams = (g) => g.toFixed(4)

  return `${headerSection}${timeSection}

💰 Beli ${buyFormatted} | Jual ${sellFormatted}

📲 Silakan hubungi: wa.me/${CONTACT_PREMIUM}
✨ Kelebihan Versi Premium:
• ⚡ Update real-time
• 📊 Notifikasi NAIK/TURUN instan
• 📅 Kalender ekonomi USD lengkap
• ✅ Status NORMAL/TIDAK NORMAL
• 🎁 Perhitungan profit otomatis
• 📉 Spread percentage
• 🌐 Akses website: ts.muhamadaliyudin.xyz`
}

async function fetchTreasury() {
  const res = await fetch(TREASURY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(3000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
    throw new Error('Invalid data')
  }
  return json
}

async function doBroadcast(priceChange, priceData) {
  if (isBroadcasting || !sock || !isReady || subscriptions.size === 0) return

  isBroadcasting = true
  broadcastCount++
  const currentBroadcastId = broadcastCount

  try {
    const treasuryData = {
      data: {
        buying_rate: priceData.buy,
        selling_rate: priceData.sell,
        updated_at: priceData.updated_at
      }
    }

    const usdRate = cachedMarketData.usdIdr?.rate || null
    const message = formatMessage(treasuryData, usdRate, cachedMarketData.xauUsd, priceChange, cachedMarketData.economicEvents)

    pushLog(`📤 [#${currentBroadcastId}] Sending to ${subscriptions.size} subs...`)

    subscriptions.forEach(chatId => {
      sock.sendMessage(chatId, { text: message }).catch(() => {})
    })

    pushLog(`📤 [#${currentBroadcastId}] Broadcast sent!`)

  } catch (e) {
    pushLog(`❌ Broadcast #${currentBroadcastId} error: ${e.message}`)
  } finally {
    isBroadcasting = false
  }
}

async function checkPriceUpdate() {
  if (!isReady || subscriptions.size === 0) return

  try {
    const treasuryData = await fetchTreasury()
    const currentPrice = {
      buy: treasuryData?.data?.buying_rate,
      sell: treasuryData?.data?.selling_rate,
      updated_at: treasuryData?.data?.updated_at,
      fetchedAt: Date.now()
    }

    if (!lastKnownPrice) {
      lastKnownPrice = currentPrice
      lastBroadcastedPrice = currentPrice
      lastPriceUpdateTime = Date.now()
      pushLog(`📊 Initial: Buy=${formatRupiah(currentPrice.buy)}, Sell=${formatRupiah(currentPrice.sell)}`)
      return
    }

    const buyChanged = lastKnownPrice.buy !== currentPrice.buy
    const sellChanged = lastKnownPrice.sell !== currentPrice.sell

    const now = Date.now()
    const timeSinceLastBroadcast = now - lastBroadcastTime

    if (!buyChanged && !sellChanged) {
      return
    }

    // Update last known price
    const priceChange = {
      buyChange: currentPrice.buy - lastKnownPrice.buy,
      sellChange: currentPrice.sell - lastKnownPrice.sell
    }

    lastKnownPrice = currentPrice
    lastPriceUpdateTime = now

    // 🆓 VERSI GRATIS: Broadcast setiap jam xx:01
    const currentMinute = new Date().getMinutes()
    const shouldBroadcastNow = currentMinute === 1 && timeSinceLastBroadcast >= 3000000 // 50 menit min

    if (!shouldBroadcastNow) {
      // Hitung waktu ke jam berikutnya
      const nextHour = new Date()
      nextHour.setHours(nextHour.getHours() + 1)
      nextHour.setMinutes(1)
      nextHour.setSeconds(0)
      const remainingMs = nextHour.getTime() - now
      const remainingMins = Math.floor(remainingMs / 60000)
      pushLog(`🔔 Price changed! Next broadcast at ${nextHour.getHours().toString().padStart(2, '0')}:01 (${remainingMins}m)`)
      return
    }

    const finalPriceChange = {
      buyChange: currentPrice.buy - lastBroadcastedPrice.buy,
      sellChange: currentPrice.sell - lastBroadcastedPrice.sell
    }

    lastBroadcastTime = now
    lastBroadcastedPrice = {
      buy: currentPrice.buy,
      sell: currentPrice.sell,
      fetchedAt: currentPrice.fetchedAt
    }

    pushLog(`📢 Broadcasting update (10-min interval)`)

    setImmediate(() => {
      doBroadcast(finalPriceChange, currentPrice).catch(e => {
        pushLog(`❌ Broadcast error: ${e.message}`)
      })
    })

  } catch (e) {
    // Silent fail
  }
}

setInterval(checkPriceUpdate, PRICE_CHECK_INTERVAL)

console.log(`🆓 VERSI GRATIS - Update setiap JAM (xx:01)`)
console.log(`📲 Premium (real-time): wa.me/${CONTACT_PREMIUM}`)
console.log(``)
console.log(`📊 Price check: every ${PRICE_CHECK_INTERVAL/1000}s`)
console.log(`⏰ Broadcast: setiap jam xx:01 WIB`)
console.log(`📅 Economic calendar: USD High-Impact\n`)

const app = express()
app.use(express.json())

app.get('/', (_req, res) => {
  res.status(200).send('✅ Bot Running (Versi Gratis)')
})

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    version: 'free',
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
    ready: isReady,
    subscriptions: subscriptions.size,
    wsConnected: sock?.ws?.readyState === 1
  })
})

app.get('/qr', async (_req, res) => {
  if (!lastQr) return res.send('<pre>QR not ready</pre>')
  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.send(`<div style="text-align:center;padding:20px"><img src="${dataUrl}" style="max-width:400px"/></div>`)
    }
  } catch (_) {}
  res.send(lastQr)
})

app.get('/stats', (_req, res) => {
  const now = Date.now()
  const timeSinceLastBroadcast = lastBroadcastTime > 0 ? now - lastBroadcastTime : null
  const nextBroadcastIn = timeSinceLastBroadcast ? Math.max(0, BROADCAST_COOLDOWN - timeSinceLastBroadcast) : null

  res.json({
    version: 'free',
    status: isReady ? '🟢' : '🔴',
    uptime: Math.floor(process.uptime()),
    subs: subscriptions.size,
    lastPrice: lastKnownPrice,
    broadcastCount: broadcastCount,
    lastBroadcastTime: lastBroadcastTime > 0 ? new Date(lastBroadcastTime).toISOString() : null,
    nextBroadcastIn: nextBroadcastIn ? `${Math.floor(nextBroadcastIn/60000)}m ${Math.floor((nextBroadcastIn%60000)/1000)}s` : null,
    broadcastCooldown: `${BROADCAST_COOLDOWN/60000} minutes`,
    logs: logs.slice(-20)
  })
})

app.listen(PORT, () => {
  console.log(`🌐 Server: http://localhost:${PORT}`)
  console.log(`📊 Stats: http://localhost:${PORT}/stats`)
  console.log(`💊 Health: http://localhost:${PORT}/health\n`)
})

// KEEP-ALIVE SYSTEM
const SELF_URL = process.env.RENDER_EXTERNAL_URL ||
                 process.env.RAILWAY_STATIC_URL ||
                 `http://localhost:${PORT}`

console.log(`🏓 Keep-alive target: ${SELF_URL}`)
console.log(`🏓 Keep-alive interval: 60 seconds\n`)

setInterval(async () => {
  try {
    const response = await fetch(`${SELF_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })

    if (response.ok) {
      const data = await response.json()
      pushLog(`🏓 Ping OK (uptime: ${Math.floor(data.uptime/60)}m, subs: ${data.subscriptions})`)
    }
  } catch (e) {
    pushLog(`⚠️  Ping failed: ${e.message}`)
  }
}, 60 * 1000)

setTimeout(async () => {
  try {
    const response = await fetch(`${SELF_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    if (response.ok) {
      pushLog('🏓 Initial ping successful')
    }
  } catch (e) {
    pushLog(`⚠️  Initial ping failed: ${e.message}`)
  }
}, 30000)

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    getMessage: async () => ({ conversation: '' })
  })

  setInterval(() => {
    if (sock?.ws?.readyState === 1) sock.ws.ping()
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      lastQr = qr
      pushLog('📱 QR ready at /qr')
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      pushLog(`❌ Connection closed: ${reason}`)

      if (reason === DisconnectReason.loggedOut) {
        pushLog('🚪 LOGGED OUT - Manual login required')
        return
      }

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        pushLog(`🔄 Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        setTimeout(() => start(), delay)
      } else {
        pushLog('❌ Max reconnect attempts reached')
      }

    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      pushLog('✅ WhatsApp connected')

      isReady = false
      pushLog('⏳ Warming up 15s...')

      setTimeout(async () => {
        try {
          pushLog('💱 Fetching initial USD/IDR...')
          const usdIdr = await fetchUSDIDRFromGoogle()
          cachedMarketData.usdIdr = usdIdr
          cachedMarketData.lastUsdIdrFetch = Date.now()
          if (usdIdr?.rate) {
            pushLog(`💱 Initial USD/IDR: Rp ${usdIdr.rate.toLocaleString('id-ID')}`)
          }
        } catch (e) {
          pushLog(`⚠️ Initial USD/IDR fetch failed`)
        }

        isReady = true
        pushLog('🚀 Bot ready!')
        checkPriceUpdate()

        fetchEconomicCalendar().then(events => {
          if (events && events.length > 0) {
            pushLog(`📅 Loaded ${events.length} economic events`)
          }
        })
      }, 15000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady || ev.type !== 'notify') return

    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text) continue

        const sendTarget = msg.key.remoteJid

        if (/\baktiff\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: `✅ Sudah aktif!

🆓 Versi Gratis
⏰ Update setiap jam (xx:01 WIB)
📅 Termasuk kalender ekonomi USD

📲 Upgrade ke Premium (real-time):
wa.me/${CONTACT_PREMIUM}`
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            pushLog(`➕ New sub: ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)

            await sock.sendMessage(sendTarget, {
              text: `🎉 Berhasil Diaktifkan!

🆓 Versi Gratis
⏰ Update setiap jam (xx:01 WIB)

📲 Upgrade ke Premium (real-time):
wa.me/${CONTACT_PREMIUM}`
            }, { quoted: msg })
          }
          continue
        }

        if (/\bnonaktif\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            pushLog(`➖ Unsub: ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)
            await sock.sendMessage(sendTarget, { text: '👋 Notifikasi dihentikan.' }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, { text: '❌ Belum aktif.' }, { quoted: msg })
          }
          continue
        }

        if (!/\bemas\b/.test(text)) continue

        const now = Date.now()
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0

        if (now - lastReply < COOLDOWN_PER_CHAT) continue
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) continue

        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
        } catch (_) {}

        await new Promise(r => setTimeout(r, TYPING_DURATION))

        let replyText
        try {
          const [treasury, usdIdr, xauUsd, economicEvents] = await Promise.all([
            fetchTreasury(),
            fetchUSDIDRFromGoogle(),
            fetchXAUUSDCached(),
            fetchEconomicCalendar()
          ])
          replyText = formatMessage(treasury, usdIdr?.rate, xauUsd, null, economicEvents)
        } catch (e) {
          replyText = '❌ Gagal mengambil data harga.'
        }

        await new Promise(r => setTimeout(r, 500))

        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (_) {}

        await sock.sendMessage(sendTarget, { text: replyText }, { quoted: msg })

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now

        await new Promise(r => setTimeout(r, 1000))

      } catch (e) {
        pushLog(`❌ Message error: ${e.message}`)
      }
    }
  })
}

start().catch(e => {
  console.error('💀 Fatal error:', e)
  process.exit(1)
})
