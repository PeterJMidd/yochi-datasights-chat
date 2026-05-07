import { auth } from "@/auth"
import { SYSTEM_PROMPT } from "@/lib/system-prompt"

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    const { messages } = await req.json()

    const apiResponse = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-11-20",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
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
            authorization_token: process.env.DATASIGHTS_MCP_TOKEN!,
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

    // Extract text from response (may include mcp_tool_use and mcp_tool_result blocks)
    const textBlocks = (response.content || []).filter(
      (b: Record<string, unknown>) => b.type === "text"
    )
    const text = textBlocks
      .map((b: Record<string, unknown>) => (b.text as string) || "")
      .join("\n")

    // Stream the response as SSE
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        // Send the full text in chunks to simulate streaming
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
