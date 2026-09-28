import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./App"

// 故意不用 StrictMode：双挂载会让日志/租约演示出现重复条目，干扰观察。
const container = document.getElementById("root")
if (!container) throw new Error("#root not found")
createRoot(container).render(<App />)
