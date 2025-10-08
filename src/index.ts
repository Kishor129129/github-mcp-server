import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Load .env from the project root relative to this file, regardless of cwd
// Prevent dotenv from printing banners to stdout (breaks stdio JSON-RPC)
process.env.DOTENV_DISABLE_LOGS = process.env.DOTENV_DISABLE_LOGS ?? "true";
process.env.DOTENV_CONFIG_SILENT = process.env.DOTENV_CONFIG_SILENT ?? "true";
process.env.DOTENV_SILENT = process.env.DOTENV_SILENT ?? "true";
process.env.DOTENV_LOG = process.env.DOTENV_LOG ?? "error";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Suppress a known banner line emitted by dotenv v17
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as unknown as (str: string) => boolean) = ((
  chunk: any
) => {
  try {
    const s = typeof chunk === "string" ? chunk : String(chunk ?? "");
    if (s.includes("[dotenv@")) {
      return true as unknown as boolean; // swallow
    }
  } catch {}
  return originalStdoutWrite(chunk as any) as unknown as boolean;
}) as any;
dotenv.config({ path: path.join(__dirname, "../.env") });
// restore stdout
(process.stdout.write as any) = originalStdoutWrite;

const server = new McpServer({
  name: "github-triage-mcp",
  version: "0.1.0",
});

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.warn(
    "Warning: GITHUB_TOKEN is not set. Tools will fail for GitHub API calls."
  );
}

const octokit = new Octokit({ auth: githubToken });

const geminiKey = process.env.GEMINI_API_KEY;
const defaultModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const genAI = geminiKey ? new GoogleGenerativeAI(geminiKey) : undefined;

// Utility to present JSON results as pretty text for MCP content
function asText(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// list_repos: minimal, first 100 repos for the authenticated user
server.registerTool(
  "list_repos",
  {
    title: "List repositories",
    description:
      "List repositories for the authenticated user (first page, up to 100).",
    inputSchema: { perPage: z.number().int().min(1).max(100).optional() },
  },
  async ({ perPage }) => {
    const per_page = perPage ?? 100;
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({
      per_page,
      sort: "updated",
    });
    const slim = data.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      private: r.private,
      url: r.html_url,
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
    }));
    return { content: [{ type: "text", text: asText(slim) }] };
  }
);

// search_issues: GitHub search query syntax
server.registerTool(
  "search_issues",
  {
    title: "Search issues & PRs",
    description:
      "Search issues and pull requests using GitHub query syntax (q).",
    inputSchema: {
      q: z.string().min(1),
      perPage: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ q, perPage }) => {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q,
      per_page: perPage ?? 20,
    });
    const items = data.items.map((it) => ({
      type: it.pull_request ? "pr" : "issue",
      repo: it.repository_url?.split("/repos/")[1],
      number: it.number,
      title: it.title,
      state: it.state,
      url: it.html_url,
      labels: it.labels
        ?.map((l: any) => (typeof l === "string" ? l : l.name))
        .filter(Boolean),
    }));
    return {
      content: [
        { type: "text", text: asText({ total: data.total_count, items }) },
      ],
    };
  }
);

// summarize_pr: stub wired to Gemini; expects owner, repo, number
server.registerTool(
  "summarize_pr",
  {
    title: "Summarize PR",
    description:
      "Summarize a pull request diff and discussion using Gemini. Params: owner, repo, number.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    },
  },
  async ({ owner, repo, number }) => {
    // Fetch PR details and changed files (limited sample for demo)
    const pr = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    const files = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: number,
      per_page: 50,
    });

    const fileSummary = files.data
      .map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`)
      .join("\n");
    const prompt = `Summarize this PR for a reviewer in 6-10 bullet points. Include: intent, risky areas, breaking changes, and testing steps.\n\nPR title: ${
      pr.data.title
    }\n\nPR body:\n${
      pr.data.body || "(no body)"
    }\n\nChanged files:\n${fileSummary}`;

    if (!genAI) {
      return {
        content: [
          {
            type: "text",
            text: "Gemini API key not set; cannot summarize PR.",
          },
        ],
      };
    }
    const tryModels = [defaultModel, "gemini-1.5-flash", "gemini-1.5-pro"];
    let lastError: unknown = undefined;
    for (const modelName of tryModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const res = await model.generateContent(prompt);
        const text = res.response.text();
        return { content: [{ type: "text", text }] };
      } catch (err) {
        lastError = err;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Gemini call failed. Set GEMINI_MODEL to a supported model. Last error: ${String(
            lastError
          )}`,
        },
      ],
      isError: true,
    } as any;
  }
);

// label_issue: add one or more labels to an issue
server.registerTool(
  "label_issue",
  {
    title: "Label issue",
    description: "Add one or more labels to an issue",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      labels: z.array(z.string()).min(1),
    },
  },
  async ({ owner, repo, number, labels }) => {
    const { data } = await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: number,
      labels,
    });
    return {
      content: [{ type: "text", text: asText(data.map((l) => l.name)) }],
    };
  }
);

// close_issue: set state=closed
server.registerTool(
  "close_issue",
  {
    title: "Close issue",
    description: "Close an issue by number",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    },
  },
  async ({ owner, repo, number }) => {
    const { data } = await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      state: "closed",
    });
    return {
      content: [
        {
          type: "text",
          text: asText({ number: data.number, state: data.state }),
        },
      ],
    };
  }
);

// Connect via stdio so Inspector / Claude Desktop can attach
const transport = new StdioServerTransport();
console.error("[github-mcp] Starting server via stdio...");
console.error("[github-mcp] Working directory:", process.cwd());
console.error("[github-mcp] Env present:", {
  hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
  hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
});
console.error("[github-mcp] Gemini model:", defaultModel);
await server.connect(transport);
console.error("[github-mcp] Server connected (stdio).");
