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
        let messageCount = 0

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

                // Track message boundaries — each message_start is a new
                // turn in the MCP agentic loop
                if (event.type === "message_start") {
                  messageCount++
                  // When a new message starts after tool calls, tell the
                  // client to clear the previous "thinking" text
                  if (messageCount > 1) {
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ clear: true })}\n\n`)
                    )
                  }
                }

                // Forward text deltas to the client
                if (
                  event.type === "content_block_delta" &&
                  event.delta?.type === "text_delta" &&
                  event.delta?.text
                ) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ text: event.delta.text })}\n\n`
                    )
                  )
                }
              } catch {
                // Skip malformed JSON chunks
              }
            }
          }

          // Process any remaining buffer
          if (buffer.startsWith("data: ")) {
            const data = buffer.slice(6).trim()
            if (data && data !== "[DONE]") {
              try {
                const event = JSON.parse(data)
                if (
                  event.type === "content_block_delta" &&
                  event.delta?.type === "text_delta" &&
                  event.delta?.text
                ) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ text: event.delta.text })}\n\n`
                    )
                  )
                }
              } catch {
                // Skip
              }
            }
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch (error) {
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
