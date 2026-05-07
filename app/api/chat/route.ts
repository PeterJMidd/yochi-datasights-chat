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

    const response = await apiResponse.json()

    const textBlocks = (response.content || []).filter(
      (b: Record<string, unknown>) => b.type === "text"
    )
    const text = textBlocks
      .map((b: Record<string, unknown>) => (b.text as string) || "")
      .join("\n")

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const words = text.split(" ")
        let i = 0
        const interval = setInterval(() => {
          if (i < words.length) {
            const chunk = (i === 0 ? "" : " ") + words[i]
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`)
            )
            i++
          } else {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
            clearInterval(interval)
          }
        }, 20)
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
