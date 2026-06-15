"use client"

import { useSession, signOut } from "next-auth/react"
import { useState, useRef, useEffect, useCallback, KeyboardEvent, FormEvent } from "react"

interface Message {
  role: "user" | "assistant"
  content: string
}

export default function ChatPage() {
  const { data: session } = useSession()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef("")

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "24px"
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [input])

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || loading) return

    const userMessage: Message = { role: "user", content: trimmed }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput("")
    setLoading(true)
    setStatus("Connecting...")
    contentRef.current = ""

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)

    try {
      setStatus("Querying database...")
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => null)
        throw new Error(errData?.error || `Error: ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error("No response body")

      const decoder = new TextDecoder()
      setMessages([...newMessages, { role: "assistant", content: "" }])
      setStatus("Querying database — this can take up to 60s...")

      let lastRender = 0
      const RENDER_INTERVAL = 100
      const READ_TIMEOUT = 60000

      while (true) {
        const readPromise = reader.read()
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("No response for 60s — the query may be too complex. Try a simpler question.")), READ_TIMEOUT)
        )
        const { done, value } = await Promise.race([readPromise, timeoutPromise])
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split("\n")

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6)
            if (data === "[DONE]") break

            try {
              const parsed = JSON.parse(data)
              if (parsed.text) {
                contentRef.current += parsed.text
                const now = Date.now()
                if (now - lastRender > RENDER_INTERVAL) {
                  lastRender = now
                  setStatus("")
                  setMessages([
                    ...newMessages,
                    { role: "assistant", content: contentRef.current },
                  ])
                }
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      setMessages([
        ...newMessages,
        { role: "assistant", content: contentRef.current },
      ])
    } catch (error) {
      console.error("Chat error:", error)
      const isTimeout =
        error instanceof DOMException && error.name === "AbortError"
      const errMsg = error instanceof Error ? error.message : "Unknown error"
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: isTimeout
            ? "The query took too long. Try a simpler question or break it into steps."
            : `Error: ${errMsg}`,
        },
      ])
    } finally {
      clearTimeout(timeout)
      setLoading(false)
      setStatus("")
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function renderContent(content: string) {
    // Basic markdown: bold, inline code, code blocks, tables
    let html = content
      // Code blocks
      .replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      // Inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      // Tables (simple pipe-delimited)
      .replace(
        /(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/g,
        (_match, header: string, _separator: string, body: string) => {
          const headerCells = header
            .split("|")
            .filter((c: string) => c.trim())
            .map((c: string) => `<th>${c.trim()}</th>`)
            .join("")
          const rows = body
            .trim()
            .split("\n")
            .map((row: string) => {
              const cells = row
                .split("|")
                .filter((c: string) => c.trim())
                .map((c: string) => `<td>${c.trim()}</td>`)
                .join("")
              return `<tr>${cells}</tr>`
            })
            .join("")
          return `<table><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`
        }
      )

    return <div dangerouslySetInnerHTML={{ __html: html }} />
  }

  const userInitial = session?.user?.name?.[0]?.toUpperCase() || "U"

  return (
    <div className="chat-container">
      <div className="header">
        <div className="header-title">
          YoChi <span>DataSights</span>
        </div>
        <div className="header-right">
          <div className="user-avatar">{userInitial}</div>
          <button className="sign-out-btn" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="welcome-container">
          <div className="welcome-icon">&#x1F4CA;</div>
          <h2 className="welcome-title">Welcome to DataSights</h2>
          <p className="welcome-subtitle">
            Ask me anything about your YoChi data — sales, reviews, staff,
            finances, maintenance, and more. I can query across all 64
            DataSights tables.
          </p>
        </div>
      ) : (
        <div className="messages-area">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`message message-${msg.role}`}
            >
              <div className="message-bubble">
                {msg.role === "assistant" ? (
                  renderContent(msg.content)
                ) : (
                  msg.content
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="message message-assistant">
              <div className="message-bubble">
                {status && <div className="status-text">{status}</div>}
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="input-area">
        <form onSubmit={handleSubmit} className="input-container">
          <textarea
            ref={textareaRef}
            className="input-textarea"
            placeholder="Ask about sales, reviews, staff, finances..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            type="submit"
            className="send-btn"
            disabled={loading || !input.trim()}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </form>
        <div className="footer">Powered by Claude + DataSights</div>
      </div>
    </div>
  )
}
