import { auth } from "@/auth"
import { SYSTEM_PROMPT } from "@/lib/system-prompt"

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getDataSightsToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken
  }

  const res = await fetch(process.env.DATASIGHTS_TOKEN_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.DATASIGHTS_CLIENT_ID!,
      client_secret: process.env.DATASIGHTS_CLIENT_SECRET!,
    }),
  })

  if (!res.ok) {
    throw new Error(`DataSights token error: ${res.status}`)
  }

  const data = await res.json()
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000
  return cachedToken!
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    const { messages } = await req.json()
    const mcpToken = await getDataSightsToken()

    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-11-20",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
        mcp_servers: [
          {
            type: "url",
            url: process.env.DATASIGHTS_MCP_URL!,
            name: "datasights",
            authorization_token: mcpToken,
          },
        ],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: "datasights",
          },
        ],
      }),
    })

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text()
      console.error("Anthropic API error:", apiResponse.status, errorBody)
      throw new Error(`Anthropic API error: ${apiResponse.status}`)
    }

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const stream = new ReadableStream({
      async start(controller) {
        const reader = apiResponse.body?.getReader()
        if (!reader) {
          controller.close()
          return
        }

        let buffer = ""
        // Collect text segments between tool calls. Each time we see a
        // tool_use block, the preceding text is "thinking". The text after
        // the LAST tool call is the final answer.
        let segments: string[] = []
        let currentSegment = ""
        let hasSeenToolUse = false

        // Send a keepalive comment every few seconds so the connection stays open
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"))
          } catch {
            clearInterval(keepalive)
          }
        }, 5000)

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const data = line.slice(6).trim()
              if (data === "[DONE]" || !data) continue

              try {
                const event = JSON.parse(data)

                // When a tool_use block starts, save current text as a
                // "thinking" segment and start fresh
                if (
                  event.type === "content_block_start" &&
                  event.content_block?.type === "tool_use"
                ) {
                  if (currentSegment) {
                    segments.push(currentSegment)
                    currentSegment = ""
                  }
                  hasSeenToolUse = true
                }

                // Accumulate text deltas
                if (
                  event.type === "content_block_delta" &&
                  event.delta?.type === "text_delta" &&
                  event.delta?.text
                ) {
                  currentSegment += event.delta.text
                }
              } catch {
                // Skip malformed JSON chunks
              }
            }
          }

          clearInterval(keepalive)

          // Save the last segment
          if (currentSegment) {
            segments.push(currentSegment)
          }

          // If tool calls were made, only send the last segment (the answer).
          // If no tool calls, send everything (simple response).
          const finalText = hasSeenToolUse
            ? segments[segments.length - 1] || ""
            : segments.join("")

          // Stream the final text word by word for a nice typing effect
          if (finalText) {
            const words = finalText.split(" ")
            for (let i = 0; i < words.length; i++) {
              const chunk = (i === 0 ? "" : " ") + words[i]
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ text: chunk })}\n\n`
                )
              )
            }
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch (error) {
          clearInterval(keepalive)
          console.error("Stream processing error:", error)
          controller.error(error)
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    console.error("Chat API error:", error)
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred"
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
