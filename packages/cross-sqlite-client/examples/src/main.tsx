import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./App"

// 故意不用 StrictMode：双挂载会建两个数据库连接/抢两次单标签页锁，干扰观察。
const container = document.getElementById("root")
if (!container) throw new Error("#root not found")
createRoot(container).render(<App />)
