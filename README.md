# Babbar MCP Server

A Model Context Protocol (MCP) server that integrates with the [Babbar.tech SEO API](https://www.babbar.tech), enabling AI assistants (Claude, ChatGPT with MCP, etc.) to perform advanced SEO analysis, competitor research, backlink auditing, and content gap identification.

---

## Features

### Comprehensive SEO Analysis
- **Host/Domain/URL Overview**: Popularity (Value), Trust, Semantic Value, Babbar Authority Score (BAS)
- **Backlink Analysis**: URL, host, and domain backlink profiles
- **Anchor Text Analysis**: Anchor distribution and risk detection
- **Page Analysis**: Identify top pages by Page Value, Trust, Semantic Value, Internal Page Value

### Competitor Discovery & Analysis
- **Similar Hosts**: Detect semantically close competitors
- **Batch Analysis**: Compare multiple entities (hosts/domains/URLs)
- **Historical Data**: Track performance over time

### Advanced SEO Metrics
- **Induced Strength (fi)**: Unique Babbar metric measuring real link value (popularity + topicality)
- **Internal PageRank**: Internal linking analysis
- **Duplication Analysis**: RollingHash (Rabin–Karp) detection of duplicate content (87%+ threshold)

### Keywords & SERP Analysis
- **Keyword Positions**: Track Google rankings (currently supports fr_FR, en_GB, en_US, es_ES)
- **SERP Data**: Full SERP with features and positions
- **Semantic Explorer**: Related searches, People Also Ask, suggestions

### Performance & Reliability
- **Smart Caching**: 10-day cache for heavy endpoints
- **Rate Limit Management**: Auto-handling + retry after 60s
- **Usage Logging**: Full request/response logging
- **Error Handling**: Clear messages for invalid key, rate limits, or API issues

---

## 🚀 Installation & Setup

### Prerequisites
- **Node.js** 18 or higher (check with `node -v`)
- **npm** (comes with Node.js, check with `npm -v`)
- **Babbar API key** (get it from your [Babbar settings](https://www.babbar.tech/settings#/api))

### 1. Clone the repository
```bash
git clone https://github.com/BabbarTech/BabbarMCP.git
cd BabbarMCP
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
You must export your Babbar API key:
Create a .env file from the provided .env.example:
```bash
cp .env.example .env
```

Edit .env:
```dotenv
BABBAR_API_KEY=your_api_key_here
LOG_LEVEL=info
```

⚠️ Without a valid key, the server will not return real data (the API substitutes with dummy hosts/URLs).

### 4. Build the project
```bash
npm run build
```

This compiles TypeScript sources into the dist/ directory.

## ▶️ Usage
### Local development
Run in watch mode:
```bash
npm run dev
```

Run built server:
```bash
node dist/index.js
```

### With Claude Desktop
Add this block to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "babbar": {
      "command": "node",
      "args": ["/absolute/path/to/babbar-mcp/dist/index.js"],
      "env": {
        "BABBAR_API_KEY": "your_api_key_here",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### With ChatGPT Desktop (MCP support)

Go to Settings > MCP Servers, and add a new server with:
Command: node
Args: /absolute/path/to/babbar-mcp/dist/index.js
Env: at least BABBAR_API_KEY

## 🛠️ Available Tools (highlights)

### Host Analysis
- `babbar_host_overview` → Metrics for a host
- `babbar_host_backlinks_url|host|domain` → Backlink analysis
- `babbar_host_anchors` → Anchor distribution
- `babbar_host_pages_top_sv|pt|pv|iev` → Top pages by different metrics
- `babbar_host_similar` → Competitor discovery
- `babbar_host_keywords` → Keywords and rankings
- `babbar_host_duplicate` → Duplicate content clusters

### Domain Analysis
- `babbar_domain_overview`
- `babbar_domain_backlinks_*`
- `babbar_domain_anchors`

### URL Analysis
- `babbar_url_overview`
- `babbar_url_induced_strength (fi)`
- `babbar_url_semantic_similarity`
- `babbar_url_links_internal|external`

### Keyword & SERP
- `babbar_keyword_serp`
- `babbar_semantic_questions`
- `babbar_semantic_related`
- `babbar_semantic_suggests`

### Advanced Analyses
- `babbar_content_gap`
- `babbar_competitive_analysis`
- `babbar_anchor_profile_risk`
- `babbar_backlink_opportunities_spotfinder` (uses Induced Strength only)

## 📖 Example Queries (works in French)
- **Do a full metrics analysis of whisky.glass**  
- **Give me backlink opportunities for www.recette-americaine.com**  
- **Tell me about the semantic neighborhood of www.clubmed.fr**  
- **Can you run a content gap analysis for whisky.glass?**  
- **Show me the internal duplication issues within whisky.glass**  
- **Provide me with a health analysis of whisky.glass**  

## 📊 Understanding Babbar Metrics

- **Page/Host/Domain Value (0–100)** → Popularity (Reasonable Surfer model)  
- **Page/Host/Domain Trust (0–100)** → Trust score (not a direct Google authority factor)  
- **Semantic Value (0–100)** → Popularity adjusted by topical coherence  
- **BAS (0–100)** → Combined authority score with anti-spam (best correlated to Google rankings)  
- **Induced Strength (fi)** → Only valid metric for backlink value, computed by Babbar API  

💡 **Tip**: Always benchmark your metrics against your direct competitors, not the whole web.

## Rate Limiting

- Each plan has a per-minute API quota.  
- Remaining calls are tracked via headers (`x-ratelimit-remaining`).  
- The MCP server auto-waits **60 seconds** when the limit is exhausted.  
- Errors are explicit if multiple processes compete for the limit.

## Caching

- Cache enabled on **POST requests** (main data endpoints)  
- Cache lifetime: **10 days**  
- Cache key = **endpoint + parameters**  
- Reduces redundant queries and saves API credits

## 🐞 Error Handling

- **401 Unauthorized** → Invalid or missing `BABBAR_API_KEY`  
- **429 Too Many Requests** → Rate limit exceeded, auto-retry after 60s  
- **400/404/Other** → Detailed error, check parameters  

Logs include: endpoint, timestamp, status, and remaining quota.

## 📜 Logging

- Default: **info** level  
- Levels: `debug`, `info`, `warn`, `error`  
- Configure via `LOG_LEVEL` environment variable  
- Logs include endpoint calls, rate limit status, success/failure  

## 🛠️ Development

Run in watch mode:
```bash
npm run dev
```

Rebuild manually:

```bash
npm run build
```

Lint the code:
```bash
npm run lint
```

## 🤝 Support

- **API Support**: support@babbar.tech  
- **Docs**: [Babbar API Reference](https://www.babbar.tech/doc-api/)  
- **Issues**: GitHub Issues  

## 📄 License

MIT License – see `LICENSE`.

## 🙌 Contributing

Contributions are welcome!  
Please open an issue first to discuss changes. Pull requests should include tests when possible.

## ⚡ Acknowledgments

Built with:

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol)  
- [Babbar.tech API](https://www.babbar.tech)  
- Node.js, TypeScript, Axios, Node-Cache, Pino
