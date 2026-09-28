import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./App"

// 故意不用 StrictMode：演示组件挂载时会写 localStorage / 抢锁，双挂载会让
// 跨标签页演示的日志出现重复条目，干扰观察。
const container = document.getElementById("root")
if (!container) throw new Error("#root not found")
createRoot(container).render(<App />)
