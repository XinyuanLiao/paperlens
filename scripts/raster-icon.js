// 把 SVG 图标渲染成 1024px PNG（供 iconutil / electron-builder 使用）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4E8BFF"/><stop offset="1" stop-color="#2352D8"/>
    </linearGradient>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9EEF7"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <rect x="312" y="216" width="400" height="592" rx="40" fill="url(#paper)"/>
  <rect x="372" y="316" width="280" height="26" rx="13" fill="#8E99AC"/>
  <rect x="372" y="396" width="280" height="26" rx="13" fill="#FFD60A"/>
  <rect x="372" y="400" width="196" height="18" rx="9" fill="#3B465C"/>
  <rect x="372" y="476" width="280" height="26" rx="13" fill="#C4CCDA"/>
  <rect x="372" y="556" width="240" height="26" rx="13" fill="#C4CCDA"/>
  <rect x="372" y="636" width="180" height="26" rx="13" fill="#C4CCDA"/>
  <circle cx="664" cy="672" r="96" fill="#2352D8" opacity="0.12"/>
  <circle cx="664" cy="672" r="82" fill="none" stroke="#FFFFFF" stroke-width="34"/>
  <rect x="722" y="736" width="120" height="44" rx="22" transform="rotate(45 722 736)" fill="#FFFFFF"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  const b64 = Buffer.from(svg).toString('base64')
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${b64}"></body>`)
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), img.toPNG())
  console.log('icon.png written')
  app.quit()
})
