import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CompactCard from './CompactCard'
import { isCompactQuery } from './compact'
import './styles.css'

/**
 * 小部件模式（`?compact=1`）在**渲染之前**就给 <html>/<body> 挂上 cc-mode。
 *
 * 必须同步做，不能等组件 effect：effect 在首帧之后才跑，透明窗口会先闪一块
 * 不透明的深色矩形——那正是这个窗口最不该有的东西。
 */
const compact = isCompactQuery(window.location.search)
if (compact) {
  document.documentElement.classList.add('cc-mode')
  document.body.classList.add('cc-mode')
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{compact ? <CompactCard /> : <App />}</React.StrictMode>,
)
