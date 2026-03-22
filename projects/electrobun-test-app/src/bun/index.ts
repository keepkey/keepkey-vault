import { BrowserWindow } from "electrobun/bun";

console.log("[test-app] starting");
console.log("[test-app] platform:", process.platform);
console.log("[test-app] creating BrowserWindow");

const mainWindow = new BrowserWindow({
	title: "Electrobun Test App",
	width: 600,
	height: 400,
	url: "views://mainview/index.html",
});

console.log("[test-app] BrowserWindow created, window should be visible");
console.log("[test-app] if you see this log but no window, WebView2 init failed");
