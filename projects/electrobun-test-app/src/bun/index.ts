// Electrobun Test App — staged import test
// Each stage logs before and after to find what kills the process.
// If a stage hangs, the last log line tells you which import is the problem.

import * as fs from "fs";
const LOG_DIR = (process.platform === 'win32' ? process.env.LOCALAPPDATA : (process.env.HOME + "/Library/Application Support")) + "/com.keepkey.electrobun-test"
const LOG_FILE = LOG_DIR + "/test-app.log"
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
const log = (msg: string) => {
	const line = `[${new Date().toISOString()}] ${msg}\n`
	logStream.write(line)
	process.stdout.write(line)
}

log("=== TEST APP STARTING ===")
log("platform: " + process.platform)
log("pid: " + process.pid)
log("argv: " + process.argv.join(" "))

// ── STAGE 1: Electrobun imports ──
log("STAGE 1: importing electrobun/bun...")
import { BrowserWindow, Updater, Utils, ApplicationMenu } from "electrobun/bun"
log("STAGE 1: OK")

// ── STAGE 2: Create window FIRST (like vault does after deferred init fix) ──
log("STAGE 2: creating BrowserWindow...")
const mainWindow = new BrowserWindow({
	title: "Electrobun Test App v2",
	width: 800,
	height: 600,
	url: "views://mainview/index.html",
})
log("STAGE 2: BrowserWindow created")

// ── STAGE 3: Node built-ins ──
log("STAGE 3: importing node built-ins...")
import * as os from "os"
import * as path from "path"
log("STAGE 3: OK — os.platform=" + os.platform() + " arch=" + os.arch())

// ── STAGE 4: Try loading native addons (these are external, loaded at runtime) ──
log("STAGE 4: trying native addon imports...")

let hidOk = false
try {
	log("STAGE 4a: require('node-hid')...")
	const HID = require("node-hid")
	hidOk = true
	log("STAGE 4a: OK — node-hid loaded, devices: " + HID.devices().length)
} catch (e: any) {
	log("STAGE 4a: FAILED — " + e.message)
}

let usbOk = false
try {
	log("STAGE 4b: require('usb')...")
	const usb = require("usb")
	usbOk = true
	log("STAGE 4b: OK — usb loaded")
} catch (e: any) {
	log("STAGE 4b: FAILED — " + e.message)
}

let ethersOk = false
try {
	log("STAGE 4c: require('ethers')...")
	const ethers = require("ethers")
	ethersOk = true
	log("STAGE 4c: OK — ethers loaded, version: " + ethers.version)
} catch (e: any) {
	log("STAGE 4c: FAILED — " + e.message)
}

let protoOk = false
try {
	log("STAGE 4d: require('google-protobuf')...")
	const proto = require("google-protobuf")
	protoOk = true
	log("STAGE 4d: OK — google-protobuf loaded")
} catch (e: any) {
	log("STAGE 4d: FAILED — " + e.message)
}

let hdwalletOk = false
try {
	log("STAGE 4e: require('@keepkey/hdwallet-core')...")
	const core = require("@keepkey/hdwallet-core")
	hdwalletOk = true
	log("STAGE 4e: OK — hdwallet-core loaded")
} catch (e: any) {
	log("STAGE 4e: FAILED — " + e.message)
}

let deviceProtoOk = false
try {
	log("STAGE 4f: require('@keepkey/device-protocol')...")
	const dp = require("@keepkey/device-protocol")
	deviceProtoOk = true
	log("STAGE 4f: OK — device-protocol loaded")
} catch (e: any) {
	log("STAGE 4f: FAILED — " + e.message)
}

// ── STAGE 5: Summary ──
log("=== IMPORT SUMMARY ===")
log("node-hid: " + (hidOk ? "OK" : "FAILED"))
log("usb: " + (usbOk ? "OK" : "FAILED"))
log("ethers: " + (ethersOk ? "OK" : "FAILED"))
log("google-protobuf: " + (protoOk ? "OK" : "FAILED"))
log("hdwallet-core: " + (hdwalletOk ? "OK" : "FAILED"))
log("device-protocol: " + (deviceProtoOk ? "OK" : "FAILED"))
log("Window created: YES (if you see this, BrowserWindow succeeded)")
log("=== TEST APP READY ===")
