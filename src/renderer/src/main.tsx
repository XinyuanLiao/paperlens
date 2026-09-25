import React from 'react'
import { createRoot } from 'react-dom/client'
// 内置开源字体（OFL，随安装包分发）：回复衬线 Literata / 界面无衬线 Inter / 大标题展示衬线 Playfair Display
import '@fontsource-variable/literata'
import '@fontsource-variable/literata/wght-italic.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/playfair-display'
import '@fontsource-variable/playfair-display/wght-italic.css'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
