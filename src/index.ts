import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance, AxiosError } from "axios";
import NodeCache from "node-cache";
import pino from "pino";

// Initialize logger
const logger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  pino.destination({ dest: 2 }) // 2 = stderr
);

// Fonction utilitaire pour valider et extraire les données API
function safeExtractData(response: any, dataType?: string): any[] {
  if (!response) {
    logger.warn("safeExtractData: La réponse est nulle ou non définie.");
    return [];
  }

  // L'API Babbar encapsule souvent les données dans une propriété `data`
  const data = response.data || response;

  const candidates: any[] = [];

  // Logique spécifique basée sur le type de données attendu
  if (dataType === 'keywords') {
    candidates.push(data.entries, data.keywords, data.results);
  } else if (dataType === 'hosts') {
    candidates.push(data.hosts, data.similar, data.results);
  } else if (dataType === 'urls' || dataType === 'pages') {
    candidates.push(data.pages, data.urls, data.results);
  } else if (dataType === 'backlinks') {
    candidates.push(data.backlinks, data.links, data.results);
  } else {
    // Fallback générique pour les autres cas
    candidates.push(
      data.entries, data.keywords, data.hosts, data.similar,
      data.pages, data.urls, data.backlinks, data.links, data.results
    );
  }

  // Ajouter `data` lui-même comme candidat final si c'est un tableau
  if (Array.isArray(data)) {
    candidates.push(data);
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      logger.debug(`safeExtractData: Données trouvées, ${candidate.length} éléments.`);
      return candidate;
    }
  }

  logger.warn(`safeExtractData: Aucun tableau valide trouvé pour le type '${dataType}'.`);
  return [];
}

// Fonction pour calculer la pertinence d'un concurrent
function calculateCompetitorRelevance(
  baseKeywords: Set<string>,
  competitorKeywords: string[],
  similarityScore: number
): { commonCount: number; commonRatio: number; relevanceScore: number; isRelevant: boolean } {
  const commonKeywords = competitorKeywords.filter(kw => baseKeywords.has(kw));
  const commonCount = commonKeywords.length;
  // Ratio de mots-clés communs par rapport au total du concurrent
  const commonRatio = competitorKeywords.length > 0 ? commonCount / competitorKeywords.length : 0;

  // Score de pertinence pondéré : 60% similarité sémantique, 40% partage de mots-clés
  const relevanceScore = (similarityScore * 0.6) + (commonRatio * 100 * 0.4);

  // Un concurrent est pertinent s'il a au moins 10 mots-clés en commun ET un score de pertinence > 50
  const isRelevant = commonCount >= 10 && relevanceScore > 50;

  return { commonCount, commonRatio, relevanceScore, isRelevant };
}

// Fonction utilitaire pour extraire les mots-clés
function extractKeywords(kwList: any[]): string[] {
  return kwList
    .map((k: any) => {
      // Essayer plusieurs champs possibles pour le mot-clé
      const keyword = k.keywords || k.keyword || k.query || k.q || k.term || k.text || "";
      return String(keyword).toLowerCase().trim();
    })
    .filter(Boolean); // Filtrer les chaînes vides
}

// Fonction pour identifier les opportunités de mots-clés
function findKeywordOpportunities(
  baseKeywords: any[],
  competitorKeywords: any[],
  competitorHost: string
): any[] {
  const baseKwMap = new Map<string, number>();
  baseKeywords.forEach(kw => {
    const keyword = (kw.keyword || kw.query || "").toLowerCase();
    const position = Number(kw.position || kw.rank || 999);
    if (keyword) baseKwMap.set(keyword, position);
  });

  const opportunities: any[] = [];

  competitorKeywords.forEach(kw => {
    const keyword = (kw.keyword || kw.query || "").toLowerCase();
    const competitorPosition = Number(kw.position || kw.rank || 999);
    const volume = Number(kw.volume || kw.searchVolume || 0);

    if (!keyword) return;

    const ourPosition = baseKwMap.get(keyword) || 999; // 999 = non classé

    // Opportunité = Le concurrent est dans le top 10, et nous sommes au-delà (ou pas classé)
    if (competitorPosition <= 10 && ourPosition > 10) {
      opportunities.push({
        keyword,
        competitorHost,
        competitorPosition,
        ourPosition: ourPosition === 999 ? "Non classé" : ourPosition,
        volume,
        gap: ourPosition - competitorPosition,
        // Priorité basée sur la position du concurrent
        priority: competitorPosition <= 3 ? "High" : competitorPosition <= 5 ? "Medium" : "Low"
      });
    }
  });

  // Trier par position du concurrent (meilleure en premier) puis par volume
  return opportunities.sort((a, b) => (a.competitorPosition - b.competitorPosition) || (b.volume - a.volume));
}

// Fonction utilitaire pour extraire les hosts
function extractHosts(hostList: any[]): string[] {
  return hostList
    .map((h: any) => {
      // Essayer plusieurs champs possibles pour le host
      const host = h.host || h.similar || h.hostname || h.domain || h;
      return String(host).toLowerCase().trim();
    })
    .filter(Boolean);
}

// Fonction utilitaire pour extraire les URLs
function extractUrls(pageList: any[]): string[] {
  return pageList
    .map((p: any) => {
      // Essayer plusieurs champs possibles pour l'URL
      const url = p.url || p.page || p.href || p.link || p.uri || "";
      return String(url).trim();
    })
    .filter(Boolean);
}

function asMcpContent(value: any) {
  // Format correct pour MCP : seulement du texte
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text: text,
      },
    ],
  };
}

// Petites constantes pratiques
const TODAY = () => new Date().toISOString().split("T")[0];
const DEFAULT_LANG = "fr";
const DEFAULT_COUNTRY = "FR";

// Cache configuration (10 days = 864000 seconds)
const cache = new NodeCache({ stdTTL: 864000 });

// API Configuration
const API_BASE_URL = "https://www.babbar.tech/api";
const API_KEY = process.env.BABBAR_API_KEY;

if (!API_KEY) {
  logger.error("BABBAR_API_KEY environment variable is required");
  process.exit(1);
}

// Rate limiting state
let rateLimitRemaining: number | null = null;
let rateLimitReset: Date | null = null;

// Create axios instance with default config
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  params: { api_token: API_KEY }, // ✅ la clé passe en query string partout
});

// Add response interceptor for rate limit handling
apiClient.interceptors.response.use(
  (response) => {
    // Update rate limit info from headers
    if (response.headers["x-ratelimit-remaining"]) {
      rateLimitRemaining = parseInt(response.headers["x-ratelimit-remaining"]);
    }
    return response;
  },
  async (error: AxiosError) => {
    if (error.response?.status === 429) {
      // Rate limit exceeded - wait 60 seconds and retry
      logger.warn("Rate limit exceeded, waiting 60 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return apiClient.request(error.config!);
    }
    return Promise.reject(error);
  }
);

// Define the formatted response type
interface FormattedResponse {
  endpoint: string;
  timestamp: string;
  rateLimitRemaining: number | null;
  data: any;
  count?: number;
  [key: string]: any;
}

// Helper function to format API responses
function formatResponse(data: any, endpoint: string): FormattedResponse {
  // Add metadata about the response
  const formatted: FormattedResponse = {
    endpoint,
    timestamp: new Date().toISOString(),
    rateLimitRemaining,
    data,
  };

  // Add count for list responses
  if (Array.isArray(data)) {
    formatted.count = data.length;
  } else if (data && typeof data === "object") {
    // Count items in nested arrays
    Object.keys(data).forEach((key) => {
      if (Array.isArray((data as any)[key])) {
        formatted[`${key}_count`] = (data as any)[key].length;
      }
    });
  }

  return formatted;
}

// Helper function to make API calls with caching
async function makeApiCall(
  endpoint: string,
  method: string,
  data?: any,
  useCache: boolean = true
): Promise<any> {
  const cacheKey = `${method}:${endpoint}:${JSON.stringify(data || {})}`;

  // Check cache for POST requests
  if (useCache && method === "POST") {
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      logger.debug(`Cache hit for ${cacheKey}`);
      return cachedData;
    }
  }

  try {
    logger.info(`API call: ${method} ${endpoint}`);
    const response = await apiClient.request({
      method,
      url: endpoint,
      data,
    });

    const formattedData = formatResponse(response.data, endpoint);

    // Cache successful responses
    if (useCache && method === "POST") {
      cache.set(cacheKey, formattedData);
    }

    // Log API usage
    logger.info({
      endpoint,
      method,
      rateLimitRemaining,
      timestamp: new Date().toISOString(),
    });

    return formattedData;
  } catch (error: any) {
    logger.error(`API call failed: ${error.message}`);

    // ✅ AMÉLIORATION : Meilleure gestion d'erreur
    if (error.response?.status === 401) {
      throw new Error("Invalid API key. Please check your BABBAR_API_KEY environment variable.");
    } else if (error.response?.status === 429) {
      throw new Error("Rate limit exceeded. Please wait and try again or check if another process is using the API.");
    } else if (error.response?.status === 400) {
      throw new Error(`Bad request: ${error.response?.data?.message || error.message}`);
    } else if (error.response?.status === 404) {
      throw new Error(`Endpoint not found: ${endpoint}`);
    } else {
      throw new Error(
        `API error (${error.response?.status || "unknown"}): ${error.message}. For support, contact support@babbar.tech`
      );
    }
  }
}

// =====================
// Tools definitions
// =====================
const tools = [
  // --------------------
  // HOST
  // --------------------
  {
    name: "babbar_host_overview",
    description:
      "Overview complet d’un host : BAS, hostValue, hostTrust, semanticValue (scores /100), langues, volumétrie d’URLs, répartition 2xx/3xx/4xx/5xx/fail, référents.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host à analyser (ex: www.example.com)" },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_spotsfinder",
    description: "Trouve des hosts compatibles sémantiquement à partir d’un contenu.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Texte d’entrée" },
        lang: { type: "string", description: "Langue (ex: fr, en, es)", default: DEFAULT_LANG },
      },
      required: ["content"],
    },
  },
  {
    name: "babbar_host_backlinks_host",
    description: "Top hosts référents d’un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_backlinks_url",
    description: "Top backlinks (URLs référentes) pour un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
        order: { type: "string", enum: ["asc", "desc"], default: "desc" },
        metric: {
          type: "string",
          enum: ["semanticValue", "pageValue", "pageTrust", "babbarAuthorityScore"],
          default: "semanticValue",
        },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_backlinks_url_list",
    description: "Top des meilleurs backlinks (variante 'list') pour un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_backlinks_domain",
    description: "Top domaines référents d’un host (préférer host vs domain pour la logique).",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_anchors",
    description: "Profil d’ancres d’un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_pages_top_pv",
    description: "Top pages internes triées par PageValue.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_pages_top_pt",
    description: "Top pages internes triées par PageTrust.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_pages_top_sv",
    description: "Top pages internes triées par SemanticValue.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_pages_top_iev",
    description: "Top pages internes triées par InternalPageValue (intra-host).",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 100 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_health",
    description: "Score Health (/100) + répartition HTTP 2xx/3xx/4xx/5xx/fail.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_host_fetches_list",
    description: "Liste des pages connues (code HTTP, langue détectée).",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 1000 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_lang",
    description: "Langues détectées pour le host.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_host_similar",
    description: "Jusqu’à 100 hosts sémantiquement proches (concurrents).",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" }, n: { type: "number", default: 100 } },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_pages_internal",
    description: "Liste brute des pages internes.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 1000 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_ip",
    description: "Hosts sur la(les) même(s) IP que le host analysé.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_host_duplicate",
    description: "Ratios de duplication interne détectés.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_host_questions",
    description: "Questions compatibles avec le vecteur sémantique global du host.",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_neighbours",
    description: "Voisins d’un host.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_host_keywords",
    description: "Mots-clés & positions Google d’un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string", description: "YYYY-MM-DD (défaut: aujourd’hui)" },
        offset: { type: "number", default: 0 },
        n: { type: "number", default: 500 },
        min: { type: "number", default: 1 },
        max: { type: "number", default: 100 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_host_history",
    description: "Historique des métriques d’un host.",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },

  // --------------------
  // DOMAIN
  // --------------------
  {
    name: "babbar_domain_overview",
    description: "Overview global d’un domaine (agrégation).",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_backlinks_host",
    description: "Hosts référents d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_backlinks_url",
    description: "URLs référentes d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_backlinks_domain",
    description: "Domaines référents d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_anchors",
    description: "Profil d’ancres (niveau domaine).",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_pages_top_pv",
    description: "Top pages (PageValue) au sein d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_pages_top_pt",
    description: "Top pages (PageTrust) au sein d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_pages_top_sv",
    description: "Top pages (SemanticValue) au sein d’un domaine.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_health",
    description: "Health + répartition codes HTTP (niveau domaine).",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_fetches_list",
    description: "Pages crawlées/connues et leurs statuts.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, limit: { type: "number", default: 1000 }, offset: { type: "number", default: 0 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_lang",
    description: "Langues détectées au niveau domaine.",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_similar",
    description: "Domaines proches sémantiquement.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" }, n: { type: "number", default: 100 } },
      required: ["domain"],
    },
  },
  {
    name: "babbar_domain_ip",
    description: "Hosts sur la(les) même(s) IP que le domaine.",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_duplicate",
    description: "Paires de pages et ratios de duplication (interne domaine).",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },
  {
    name: "babbar_domain_history",
    description: "Historique des métriques du domaine.",
    inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
  },

  // --------------------
  // URL
  // --------------------
  {
    name: "babbar_url_overview",
    description: "Métriques principales d’une URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "babbar_url_backlinks_host",
    description: "Hosts référents d’une URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["url"],
    },
  },
  {
    name: "babbar_url_backlinks_url",
    description: "URLs référentes d’une URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["url"],
    },
  },
  {
    name: "babbar_url_backlinks_domain",
    description: "Domaines référents d’une URL (moins pertinent que host).",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, limit: { type: "number", default: 100 }, offset: { type: "number", default: 0 } },
      required: ["url"],
    },
  },
  {
    name: "babbar_url_anchors",
    description: "Ancres textuelles pointant vers l’URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "babbar_url_links_internal",
    description: "Liens internes vers l’URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "babbar_url_links_external",
    description: "Liens externes associés à l’URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "babbar_url_semantic_similarity",
    description: "Similarité sémantique entre 2 pages.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, target: { type: "string" } },
      required: ["source", "target"],
    },
  },
  {
    name: "babbar_url_induced_strength",
    description: "Force induite (transmission d’autorité) source → cible.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, target: { type: "string" } },
      required: ["source", "target"],
    },
  },
  {
    name: "babbar_url_questions",
    description: "Questions compatibles avec le vecteur sémantique de l’URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } },
      required: ["url"],
    },
  },
  {
    name: "babbar_url_keywords",
    description: "Positions & mots-clés pour une URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string" },
        offset: { type: "number", default: 0 },
        n: { type: "number", default: 200 },
        min: { type: "number", default: 1 },
        max: { type: "number", default: 100 },
      },
      required: ["url"],
    },
  },
  {
    name: "babbar_url_similar_links",
    description: "10 pages internes du même host les plus proches sémantiquement.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },

  // --------------------
  // KEYWORD & SEMANTIC EXPLORER
  // --------------------
  {
    name: "babbar_keyword_serp",
    description: "SERP connue pour un mot-clé.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string", description: "YYYY-MM-DD (défaut: aujourd’hui)" },
        feature: { type: "string", default: "ORGANIC" },
        offset: { type: "number", default: 0 },
        n: { type: "number", default: 100 },
        min: { type: "number", default: 1 },
        max: { type: "number", default: 100 },
      },
      required: ["keyword"],
    },
  },
  {
    name: "babbar_semantic_paa",
    description: "People Also Ask pour un sujet.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } }, required: ["q"] },
  },
  {
    name: "babbar_semantic_questions",
    description: "[Alias] People Also Ask pour un sujet.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } }, required: ["q"] },
  },
  {
    name: "babbar_semantic_related",
    description: "Sujets associés à un sujet donné.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } }, required: ["q"] },
  },
  {
    name: "babbar_semantic_suggests",
    description: "Google Suggest pour un sujet.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } }, required: ["q"] },
  },
  {
    name: "babbar_semantic_mindreader",
    description: "Autres sujets proposés (source complémentaire).",
    inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string", default: DEFAULT_LANG } }, required: ["q"] },
  },

  // --------------------
  // ON-PAGE
  // --------------------
  {
    name: "babbar_analyze_on_page",
    description: "Analyse d’une page pour extraire des infos de markdown/structure.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },

  // --------------------
  // BATCH de base
  // --------------------
  {
    name: "babbar_batch_overview",
    description: "Batch overview pour une liste d’items (host/domain/url).",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: ["host", "domain", "url"], default: "host" },
      },
      required: ["items"],
    },
  },

  // --------------------
  // COMPOSITES / ANALYSES
  // --------------------
  {
    name: "babbar_competitive_analysis",
    description:
      "Concurrents réels (similarité sémantique), croisement mots-clés communs, comparaison BAS/Trust/Value.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string" },
        nCompetitors: { type: "number", default: 10 },
        nKeywordsPerSite: { type: "number", default: 1000 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_serp_bin_trend",
    description: "Tendance de positions par bins (1–5/6–10/…/51–100) pour un host.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string" },
        binSize: { type: "number", default: 5 },
        maxPos: { type: "number", default: 100 },
        n: { type: "number", default: 500 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_onsite_quickwins",
    description:
      "Quickwins onsite: Health, Duplicate, top IEV, suggestions de liens via similar-links pour pages stratégiques.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        topK: { type: "number", default: 10 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_backlink_opportunities_spotfinder",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "Host du site à optimiser (obligatoire)." },
        content: { type: "string", description: "Brief SpotFinder (ou q)." },
        q: { type: "string" },
        lang: { type: "string", default: "fr" },
        targets: { type: "array", items: { type: "string" } },
        maxTargets: { type: "number", default: 18 },
        internalPageLimit: { type: "number", default: 2000 },

        topPagesPerHost: { type: "number", default: 50 },
        sourcesPoolCap: { type: "number", default: 3000 },

        // ⬇️ remplace simThreshold/maxAlignedPerTarget par :
        maxCandidatesPerTarget: { type: "number", default: 80, description: "Nb max de sources testées par target (FI)." },
        fiThreshold: { type: "number", default: 10 },

        country: { type: "string", default: "FR" },
        date: { type: "string" },

        // ⬇️ garder seulement la concurrence FI
        concurrencyFi: { type: "number", default: 8 },
        topLimit: { type: "number", default: 25 }
      },
      required: ["host"]
    }
  },
  {
    name: "babbar_anchor_profile_risk",
    description: "Profil d’ancres (brand/generic/money) + signaux de sur-optimisation.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        brandTerms: { type: "array", items: { type: "string" }, description: "Signaux de marque" },
        moneyTerms: { type: "array", items: { type: "string" }, description: "Termes transactionnels à surveiller" },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_content_gap",
    description: "Gaps thématiques vs concurrents identifiés.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        competitors: { type: "array", items: { type: "string" }, description: "Concurrents" },
        lang: { type: "string", default: DEFAULT_LANG },
      },
      required: ["host", "competitors"],
    },
  },
  {
    name: "babbar_language_localization_audit",
    description: "Audit langues: langues détectées vs mots-clés par pays/langue.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string" },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_duplicate_map",
    description: "Carte des duplications internes, scores RollingHash (Rabin–Karp) de paires de pages internes : inférieur à 0.87 (87%) : pas de duplication.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        includeKeywords: { type: "boolean", default: false },
        lang: { type: "string", default: DEFAULT_LANG },
        country: { type: "string", default: DEFAULT_COUNTRY },
        date: { type: "string" },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_fetch_status_audit",
    description: "Inventaire des fetches (codes HTTP/langues) + agrégations utiles.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        limit: { type: "number", default: 5000 },
        offset: { type: "number", default: 0 },
      },
      required: ["host"],
    },
  },
  {
    name: "babbar_ip_neighbourhood_audit",
    description: "Quartier IP & voisins (hygiène offsite, patterns à risque).",
    inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  },
  {
    name: "babbar_induced_strength_batch",
    description: "Évalue la Force Induite (la mesure de l'intérêt d'un lien) pour un backlink (couple url source, url cible).",
    inputSchema: {
      type: "object",
      properties: {
        pairs: {
          type: "array",
          description: "Liste de paires {source, target}",
          items: {
            type: "object",
            properties: { source: { type: "string" }, target: { type: "string" } },
            required: ["source", "target"],
          },
        },
      },
      required: ["pairs"],
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: "babbar-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// --- Babbar Metrics Instructions (MCP Resource) -----------------------------

const BABBAR_METRICS_URI = "instructions://babbar-metrics";
const BABBAR_METRICS_NAME = "Babbar — Dictionnaire des métriques";
const BABBAR_METRICS_DESCRIPTION = "Définitions officielles des métriques Babbar (pour prompts MCP).";

const BABBAR_METRICS_MD = `# Babbar — Metrics Dictionary

These definitions describe the metrics surfaced by Babbar.  
Reminder: most metrics are computed at the **page (URL)** level, then **aggregated** at the **host** and **domain** levels.  
**BAS** is a popularity score weighted by semantic coherence and includes an anti-spam component.

> Note: **Page Trust (PT)** measures a TrustRank-style *confidence*; it is **not** an “authority” metric used directly as a Google ranking factor.  
> **Duplication:** the “similarity percentage” in the duplication module is actually a **duplication percentage computed with a RollingHash (Rabin–Karp)** (more precise than SimHash). It is **not** semantic similarity. **Below 87% there is no duplication.**  
> **Risk threshold:** **from 87% and above**, duplication is considered **problematic** (risk of deindexing).

The induced strength is the measure of a backlink's interest.
To evaluate a backlink, the only relevant value is the induced strength (fi) of the pair of URLs marked by the link source and link target.
The induced strength is calculated by Babbar on demand, taking into account the popularity of the source page and the semantic relevance of the link.
You must therefore always use the Babbar API to obtain this metric.

## Definitions table

| Metric | Definition |
|---|---|
| **Page Value (pageValue)** | Popularity of a page (reasonable random surfer), scale 0–100. |
| **Page Trust (pageTrust)** | Confidence of a page (TrustRank-type), scale 0–100. This metric is not intended to compute “authority” as a Google ranking criterion. |
| **Page Semantic Value (semanticValue)** | Page popularity weighted by the semantic coherence of its links, 0–100. |
| **Babbar Authority Score (babbarAuthorityScore)** | Babbar’s composite authority score (0–100). It is a popularity (reasonable random surfer) weighted by semantic coherence and includes an anti-spam component. According to Babbar’s studies, this metric is the most correlated with Google rankings. |
| **Host Value (hostValue)** | Aggregated popularity at the host level (0–100). |
| **Host Trust (hostTrust)** | Aggregated trust at the host level (0–100). |
| **Host Semantic Value (semanticValue)** | SV aggregated at the host level (0–100). |
| **Domain Value (domainValue)** | Aggregated popularity at the domain level (0–100). |
| **Domain Trust (domainTrust)** | Aggregated trust at the domain level (0–100). |
| **Domain Semantic Value (semanticValue)** | SV aggregated at the domain level (0–100). |
| **Internal Page Value (internalElementValue)** | Internal popularity of a page within its host (akin to an internal PageRank). |
| **ContribPageValue** | A page’s contribution to HV/DV (%). |
| **ContribPageTrust** | A page’s contribution to HT/DT (%). |
| **ContribSemanticValue** | A page’s contribution to host/domain SV (%). |
| **ContribInternalElementValue** | A page’s contribution to the host’s IPV (%). |
| **numViewsTotal** | Total number of pages known for the host/domain. |
| **numViewsUsed** | Number of pages used to compute the “top” list. |
| **backlinks.linkCount** | Total number of backlinks. |
| **backlinks.anchorCount** | Number of distinct anchors across backlinks. |
| **backlinks.hostCount** | Number of referring hosts. Useful when analyzing “authority.” |
| **backlinks.domainCount** | Number of referring domains. |
| **backlinks.ipCount** | Number of referring IP addresses. |
| **backlinks.asCount** | Number of referring Autonomous Systems (AS). |
| **backlinks.languageCounters.count** | Backlink distribution by language (count). |
| **backlinks.countryCounters.count** | Backlink distribution by country (count). |
| **numBacklinksUsed** | Number of backlinks considered in the current response. |
| **numBacklinksTotal** | Total number of known backlinks. |
| **numBacklinksCurrent** | Number of backlinks returned on this page (paginated list). |
| **offset** | Current pagination offset. |
| **n** | Requested number of results per page (pagination). |
| **links.semanticValue** | SV of the backlink’s source page (0–100). |
| **links.pageTrust** | PT of the backlink’s source page (0–100). |
| **links.pageValue** | PV of the backlink’s source page (0–100). |
| **links.babbarAuthorityScore** | BAS of the backlink’s source page (0–100). |
| **anchors.linkCount** | Number of links using the anchor. |
| **anchors.hostCount** | Number of emitting hosts using the anchor. |
| **anchors.domainCount** | Number of emitting domains using the anchor. |
| **anchors.ipCount** | Number of emitting IPs using the anchor. |
| **anchors.percent** | Share of anchor usage (%). |
| **health** | HTTP health score (0–100). |
| **h2xx** | Number of URLs returning 2xx. |
| **h3xx** | Number of URLs returning 3xx. |
| **h4xx** | Number of URLs returning 4xx. |
| **h5xx** | Number of URLs returning 5xx. |
| **hxxx** | Number of distinct URLs crawled/fetched. |
| **hfailed** | Number of URLs with crawl failures. |
| **hRobotsDenied** | Number of URLs blocked by robots.txt (when provided). |
| **backlinksExternal** | Number of external backlinks pointing to the URL. |
| **backlinksInternal** | Number of internal backlinks pointing to the URL. |
| **numOutLinksInt** | Number of outbound links to the same host. |
| **numOutLinksExt** | Number of outbound links to other hosts. |
| **fetchTimeToFirstByte** | TTFB excluding DNS (ms). |
| **contentLength** | Content size (bytes). |
| **httpStatus** | Page HTTP status code. |
| **languages.percent** | Share of pages by language (%). |
| **categories.score** | Category confidence score (by language). |
| **rank** | URL position in the SERP. |
| **subRank** | Position within a feature block (e.g., placement inside a carousel). |
| **semanticSimilarity** | Semantic similarity between two URLs (0–100). |
| **similar.score** | Proximity score between pages (same host) using a proprietary algorithm; **not** to be confused with the RollingHash duplication percentage. |
| **neighbours.links.value** | Link intensity/proximity between two hosts in the neighborhood graph. |
| **neighbours.nodes.group** | Cluster group of the node (host). |
| **percent_from** | **Start of the RollingHash (Rabin–Karp) duplication percentage bucket** — problematic if the bucket crosses **87%+**. |
| **percent_to** | **End of the RollingHash (Rabin–Karp) duplication percentage bucket** — problematic if the bucket crosses **87%+**. |
| **pairs** | Number of URL pairs in the bucket (measured via RollingHash/Rabin–Karp). Buckets **≥ 87%** should be handled first. Any value **below 87%** indicates **no duplication**. |
| **fi** | Induced strength of an actual/simulated link (or “n/a”). |
| **confidence** | Certainty level for induced strength (LOW/HIGH). |
| **view** | Indicates whether the entity has been seen (0/1). |
| **knownUrls** | Number of known URLs for the entity (host/domain). |
| **ip (count)** | Number of known IPs (derivable from the IP list). |
| **fetches.http** | HTTP status returned for each listed page. |

---

## Practitioner Reference Table
| Action | Definition |
|---|---|
| Competitor Analysis | Identification of similar sites with overlapping keywords. |
| Content Gap | Identification of keywords that competitors rank for with a position < 10, which are not found for the analyzed site. For this, you need to retrieve the keywords of the competitors and the keyword of the analyzed site and compare them. |
| Backlink Analysis | Retrieval of the induced strength metric (fi) for the (source, target) pair to compare against other backlinks. |
| Backlink Opportunities spotfinder | Identification of potential sources for backlinks or content collaboration through babbar_host_spotsfinder|
| Keyword Opportunities | For a keyword shared by the analyzed site and competing sites: if the competitor ranks ≤ 10 and the analyzed site ranks > 10 (excluding the competitor’s branded keywords). Other way to find keyword opportunities is by finding topics not covered by the analyzed site through PAA & Mindreader & Suggests. |
| Branded Keyword | When the keyword refers specifically to a brand; e.g., “Pim’s” is a branded query for LU. |

Last updated: generated from Babbar’s internal repository (MCP).

`;

// — ListResources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: BABBAR_METRICS_URI,
        mimeType: "text/markdown",
        name: BABBAR_METRICS_NAME,
        description: BABBAR_METRICS_DESCRIPTION,
      },
    ],
  };
});

// — ReadResource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === BABBAR_METRICS_URI) {
    return {
      contents: [
        { uri, mimeType: "text/markdown", text: BABBAR_METRICS_MD },
      ],
    };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
});

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Early return if no arguments provided when needed
  if (!args) {
    throw new McpError(ErrorCode.InvalidParams, "Arguments are required for this tool");
  }

  try {
    switch (name) {
      // --------------------
      // HOST
      // --------------------
      case "babbar_host_overview":
        return asMcpContent(await makeApiCall("/host/overview/main", "POST", { host: args.host }));

      case "babbar_host_spotsfinder":
        return asMcpContent(
          await makeApiCall("/host/spotsfinder", "POST", { content: args.content, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_host_backlinks_host":
        return asMcpContent(
          await makeApiCall("/host/backlinks/host", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_backlinks_url":
        return asMcpContent(
          await makeApiCall("/host/backlinks/url", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
            order: args.order || "desc",
            metric: args.metric || "semanticValue",
          })
        );

      case "babbar_host_backlinks_url_list":
        return asMcpContent(
          await makeApiCall("/host/backlinks/url/list", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_backlinks_domain":
        return asMcpContent(
          await makeApiCall("/host/backlinks/domain", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_anchors":
        return asMcpContent(await makeApiCall("/host/anchors", "POST", { host: args.host }));

      case "babbar_host_pages_top_pv":
        return asMcpContent(
          await makeApiCall("/host/pages/top/pv", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_pages_top_pt":
        return asMcpContent(
          await makeApiCall("/host/pages/top/pt", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_pages_top_sv":
        return asMcpContent(
          await makeApiCall("/host/pages/top/sv", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_pages_top_iev":
        return asMcpContent(
          await makeApiCall("/host/pages/top/iev", "POST", {
            host: args.host,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_health":
        return asMcpContent(await makeApiCall("/host/health", "POST", { host: args.host }));

      case "babbar_host_fetches_list":
        return asMcpContent(
          await makeApiCall("/host/fetches/list", "POST", {
            host: args.host,
            limit: args.limit ?? 5000,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_lang":
        return asMcpContent(await makeApiCall("/host/lang", "POST", { host: args.host }));

      case "babbar_host_similar":
        return asMcpContent(
          await makeApiCall("/host/similar", "POST", { host: args.host, n: args.n ?? 100 })
        );

      case "babbar_host_pages_internal":
        return asMcpContent(
          await makeApiCall("/host/pages/internal", "POST", {
            host: args.host,
            limit: args.limit ?? 1000,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_host_ip":
        return asMcpContent(await makeApiCall("/host/ip", "POST", { host: args.host }));

      case "babbar_host_duplicate": {
        try {
          const host = String(args.host);
          const threshold = Number(args.threshold ?? 87);        // seuil "duplication problématique"
          const includeBelow = Boolean(args.includeBelow ?? false); // inclure les buckets < seuil dans la sortie
          const maxExamples = Number(args.examples ?? 5);        // nb d'exemples de paires à remonter par bucket

          const resp = await makeApiCall("/host/duplicate", "POST", { host });
          const raw = resp?.data ?? resp ?? {};

          // Extraction tolérante
          const rawBuckets =
            safeExtractData(resp, "buckets") ??
            raw.buckets ??
            (Array.isArray(raw) ? raw : raw.data) ??
            [];

          // Normalisation pourcentages RollingHash (Rabin–Karp)
          const normPct = (v: any): number => {
            if (v === null || v === undefined || isNaN(Number(v))) return NaN;
            let n = Number(v);
            if (n <= 1) n = n * 100;          // 0–1 → 0–100 si nécessaire
            if (n < 0) n = 0;
            if (n > 100) n = 100;
            return Math.round(n * 100) / 100; // garde 2 décimales
          };

          type Bucket = {
            rank?: number;
            percent_from: number;
            percent_to: number;
            pairs: number;
            pairs_example?: Array<{ source: string; target: string }>;
          };

          const buckets: Bucket[] = (rawBuckets || []).map((b: any) => {
            const from = normPct(b.percent_from ?? b.from ?? b.start);
            const to   = normPct(b.percent_to   ?? b.to   ?? b.end);
            return {
              rank: Number.isFinite(Number(b.rank)) ? Number(b.rank) : undefined,
              percent_from: from,
              percent_to: to,
              pairs: Number(b.pairs ?? b.count ?? 0) || 0,
              pairs_example: Array.isArray(b.pairs_example) ? b.pairs_example.slice(0, maxExamples) : [],
            };
          }).filter(b => Number.isFinite(b.percent_from) && Number.isFinite(b.percent_to));

          const crossesThreshold = (b: Bucket) => b.percent_to >= threshold;

          const severityOf = (b: Bucket): "blocker" | "critical" | "high" | "info" => {
            if (b.percent_to >= 95) return "blocker";
            if (b.percent_to >= 92) return "critical";
            if (b.percent_to >= threshold) return "high";
            return "info";
          };

          const priorityScore = (b: Bucket) => {
            // Pondère par intensité et volume
            return Math.round((b.percent_to - threshold + 1) * Math.log10(b.pairs + 10));
          };

          const labelOf = (b: Bucket) => `${b.percent_from}–${b.percent_to}%`;

          const annotated = buckets.map(b => ({
            ...b,
            isProblematic: crossesThreshold(b),
            severity: severityOf(b),
            priority: priorityScore(b),
            label: labelOf(b),
          }));

          const totalPairs = annotated.reduce((s, b) => s + b.pairs, 0);
          const problemBuckets = annotated.filter(b => b.isProblematic);
          const problemPairs = problemBuckets.reduce((s, b) => s + b.pairs, 0);

          // Tri: d'abord problématiques par priorité, puis (optionnel) les autres
          const sortedProblem = problemBuckets.sort(
            (a, b) => b.priority - a.priority || b.percent_to - a.percent_to || b.pairs - a.pairs
          );
          const sortedNonProblem = annotated
            .filter(b => !b.isProblematic)
            .sort((a, b) => b.percent_to - a.percent_to || b.pairs - a.pairs);

          const resultBuckets = includeBelow ? [...sortedProblem, ...sortedNonProblem] : sortedProblem;

          // Recommandations simples selon la sévérité
          const recommendation = (sev: string) => {
            switch (sev) {
              case "blocker":  return "Merge/redirect duplicates; canonicalize; de-duplicate content immediately.";
              case "critical": return "Canonicalize or consolidate; adjust internal linking; reduce boilerplate duplication.";
              case "high":     return "Review clusters; add uniqueness (copy, metadata); consider canonicals.";
              default:         return "Monitor; below 87% = no duplication issue.";
            }
          };

          return asMcpContent({
            host,
            params: { threshold, includeBelow, maxExamples },
            notes: {
              duplicationDefinition:
                "Duplication percentage is computed with RollingHash (Rabin–Karp); it is not semantic similarity.",
              rule: "Below 87% = no duplication. From 87% and above = problematic duplication.",
            },
            summary: {
              totalBuckets: annotated.length,
              totalPairs,
              problematicBuckets: sortedProblem.length,
              problematicPairs: problemPairs,
              threshold,
            },
            buckets: resultBuckets.map(b => ({
              label: b.label,
              percent_from: b.percent_from,
              percent_to: b.percent_to,
              pairs: b.pairs,
              severity: b.severity,
              isProblematic: b.isProblematic,
              priority: b.priority,
              recommendation: recommendation(b.severity),
              pairs_example: b.pairs_example,
            })),
          });
        } catch (error: any) {
          logger.error(`babbar_host_duplicate failed: ${error?.message || error}`);
          throw new McpError(ErrorCode.InternalError, `babbar_host_duplicate failed: ${error?.message || error}`);
        }
      }

      case "babbar_host_questions":
        return asMcpContent(
          await makeApiCall("/host/questions", "POST", { host: args.host, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_host_neighbours":
        return asMcpContent(await makeApiCall("/host/neighbours", "POST", { host: args.host }));

      case "babbar_host_keywords":
        return asMcpContent(
          await makeApiCall("/host/keywords", "POST", {
            host: args.host,
            lang: args.lang || DEFAULT_LANG,
            country: args.country || DEFAULT_COUNTRY,
            date: args.date || TODAY(),
            offset: args.offset ?? 0,
            n: args.n ?? 500,
            min: args.min ?? 1,
            max: args.max ?? 100,
          })
        );

      case "babbar_host_history":
        return asMcpContent(await makeApiCall("/host/history", "POST", { host: args.host }));

      // --------------------
      // DOMAIN
      // --------------------
      case "babbar_domain_overview":
        return asMcpContent(await makeApiCall("/domain/overview/main", "POST", { domain: args.domain }));

      case "babbar_domain_backlinks_host":
        return asMcpContent(
          await makeApiCall("/domain/backlinks/host", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_backlinks_url":
        return asMcpContent(
          await makeApiCall("/domain/backlinks/url", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_backlinks_domain":
        return asMcpContent(
          await makeApiCall("/domain/backlinks/domain", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_anchors":
        return asMcpContent(await makeApiCall("/domain/anchors", "POST", { domain: args.domain }));

      case "babbar_domain_pages_top_pv":
        return asMcpContent(
          await makeApiCall("/domain/pages/top/pv", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_pages_top_pt":
        return asMcpContent(
          await makeApiCall("/domain/pages/top/pt", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_pages_top_sv":
        return asMcpContent(
          await makeApiCall("/domain/pages/top/sv", "POST", {
            domain: args.domain,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_health":
        return asMcpContent(await makeApiCall("/domain/health", "POST", { domain: args.domain }));

      case "babbar_domain_fetches_list":
        return asMcpContent(
          await makeApiCall("/domain/fetches/list", "POST", {
            domain: args.domain,
            limit: args.limit ?? 1000,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_domain_lang":
        return asMcpContent(await makeApiCall("/domain/lang", "POST", { domain: args.domain }));

      case "babbar_domain_similar":
        return asMcpContent(
          await makeApiCall("/domain/similar", "POST", { domain: args.domain, n: args.n ?? 100 })
        );

      case "babbar_domain_ip":
        return asMcpContent(await makeApiCall("/domain/ip", "POST", { domain: args.domain }));

      case "babbar_domain_duplicate":
        return asMcpContent(await makeApiCall("/domain/duplicate", "POST", { domain: args.domain }));

      case "babbar_domain_history":
        return asMcpContent(await makeApiCall("/domain/history", "POST", { domain: args.domain }));

      // --------------------
      // URL
      // --------------------
      case "babbar_url_overview":
        return asMcpContent(await makeApiCall("/url/overview/main", "POST", { url: args.url }));

      case "babbar_url_backlinks_host":
        return asMcpContent(
          await makeApiCall("/url/backlinks/host", "POST", {
            url: args.url,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_url_backlinks_url":
        return asMcpContent(
          await makeApiCall("/url/backlinks/url", "POST", {
            url: args.url,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_url_backlinks_domain":
        return asMcpContent(
          await makeApiCall("/url/backlinks/domain", "POST", {
            url: args.url,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          })
        );

      case "babbar_url_anchors":
        return asMcpContent(await makeApiCall("/url/anchors", "POST", { url: args.url }));

      case "babbar_url_links_internal":
        return asMcpContent(await makeApiCall("/url/linksInternal", "POST", { url: args.url }));

      case "babbar_url_links_external":
        return asMcpContent(await makeApiCall("/url/linksExternal", "POST", { url: args.url }));

      case "babbar_url_semantic_similarity":
        return asMcpContent(
          await makeApiCall("/url/semanticSimilarity", "POST", { source: args.source, target: args.target })
        );

      case "babbar_url_induced_strength":
        return asMcpContent(await makeApiCall("/url/fi", "POST", { source: args.source, target: args.target }));

      case "babbar_url_questions":
        return asMcpContent(
          await makeApiCall("/url/questions", "POST", { url: args.url, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_url_keywords":
        return asMcpContent(
          await makeApiCall("/url/keywords", "POST", {
            url: args.url,
            lang: args.lang || DEFAULT_LANG,
            country: args.country || DEFAULT_COUNTRY,
            date: args.date || TODAY(),
            offset: args.offset ?? 0,
            n: args.n ?? 200,
            min: args.min ?? 1,
            max: args.max ?? 100,
          })
        );

      case "babbar_url_similar_links":
        return asMcpContent(await makeApiCall("/url/similar-links", "POST", { url: args.url }));

      // --------------------
      // KEYWORD & SEMANTIC
      // --------------------
      case "babbar_keyword_serp":
        return asMcpContent(
          await makeApiCall("/keyword", "POST", {
            keyword: args.keyword,
            lang: args.lang || DEFAULT_LANG,
            country: args.country || DEFAULT_COUNTRY,
            date: args.date || TODAY(),
            feature: args.feature || "ORGANIC",
            offset: args.offset ?? 0,
            n: args.n ?? 100,
            min: args.min ?? 1,
            max: args.max ?? 100,
          })
        );

      case "babbar_semantic_paa":
      case "babbar_semantic_questions":
        return asMcpContent(
          await makeApiCall("/semantic-explorer/paa", "POST", { q: args.q, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_semantic_related":
        return asMcpContent(
          await makeApiCall("/semantic-explorer/related", "POST", { q: args.q, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_semantic_suggests":
        return asMcpContent(
          await makeApiCall("/semantic-explorer/suggests", "POST", { q: args.q, lang: args.lang || DEFAULT_LANG })
        );

      case "babbar_semantic_mindreader":
        return asMcpContent(
          await makeApiCall("/semantic-explorer/mindreader", "POST", { q: args.q, lang: args.lang || DEFAULT_LANG })
        );

      // --------------------
      // ON-PAGE
      // --------------------
      case "babbar_analyze_on_page":
        return asMcpContent(await makeApiCall("/analyze-on-page", "POST", { url: args.url }));

      // --------------------
      // BATCH OVERVIEW
      // --------------------
      case "babbar_batch_overview": {
        const results = [];
        const items = args.items as string[];
        const type = (args.type || "host") as "host" | "domain" | "url";

        for (const item of items) {
          if (rateLimitRemaining !== null && rateLimitRemaining <= 1) {
            logger.warn("Rate limit nearly exhausted, waiting 60 seconds...");
            await new Promise((r) => setTimeout(r, 60000));
          }
          let endpoint = "";
          let data: any = {};
          if (type === "host") {
            endpoint = "/host/overview/main";
            data = { host: item };
          } else if (type === "domain") {
            endpoint = "/domain/overview/main";
            data = { domain: item };
          } else {
            endpoint = "/url/overview/main";
            data = { url: item };
          }

          try {
            const result = await makeApiCall(endpoint, "POST", data);
            results.push({ item, success: true, data: result });
          } catch (e: any) {
            results.push({ item, success: false, error: e.message });
          }
        }
        return asMcpContent({ results, totalAnalyzed: results.length });
      }

      // --------------------
      // COMPOSITES
      // --------------------
      case "babbar_competitive_analysis": {
        try {
          logger.info("Exécution de l'analyse concurrentielle...");
          const { host, lang = DEFAULT_LANG, country = DEFAULT_COUNTRY, date = TODAY(), nCompetitors = 10, nKeywordsPerSite = 1000 } = args;

          // ÉTAPE 1: Récupérer les données du host de base (mots-clés, overview)
          const [baseKwResponse, baseOverviewResponse] = await Promise.all([
            makeApiCall("/host/keywords", "POST", { host, lang, country, date, n: nKeywordsPerSite, offset: 0 }),
            makeApiCall("/host/overview/main", "POST", { host })
          ]);
          const baseKwList = safeExtractData(baseKwResponse, 'keywords');
          const baseKeywordsSet = new Set(extractKeywords(baseKwList));
          logger.info(`Host de base : ${baseKeywordsSet.size} mots-clés trouvés.`);

          // ÉTAPE 2: Trouver les concurrents sémantiques
          const similarResponse = await makeApiCall("/host/similar", "POST", { host, n: Number(nCompetitors) * 2 }); // On en prend plus pour filtrer
          const potentialCompetitors = safeExtractData(similarResponse, 'hosts');
          logger.info(`${potentialCompetitors.length} concurrents potentiels trouvés.`);

          // ÉTAPE 3: Analyser chaque concurrent
          const analysisPromises = potentialCompetitors.map(async (comp) => {
            const competitorHost = comp.host || comp.similar;
            const similarityScore = (comp.score || 0) * 100;
            if (!competitorHost) return null;

            try {
              const [cKwResponse, cOvResponse] = await Promise.all([
                makeApiCall("/host/keywords", "POST", { host: competitorHost, lang, country, date, n: nKeywordsPerSite, offset: 0 }),
                makeApiCall("/host/overview/main", "POST", { host: competitorHost })
              ]);
              const cKwList = safeExtractData(cKwResponse, 'keywords');
              const cKeywords = extractKeywords(cKwList);
              const relevance = calculateCompetitorRelevance(baseKeywordsSet, cKeywords, similarityScore);
              const opportunities = findKeywordOpportunities(baseKwList, cKwList, competitorHost);

              return {
                host: competitorHost,
                overview: cOvResponse.data,
                similarityScore: Math.round(similarityScore),
                ...relevance,
                keywordOpportunities: opportunities.slice(0, 5), // Top 5 pour ce concurrent
                success: true
              };
            } catch (e: any) {
              logger.error(`Erreur lors de l'analyse du concurrent ${competitorHost}: ${e.message}`);
              return { host: competitorHost, success: false, error: e.message };
            }
          });

          const allCompetitorAnalyses = (await Promise.all(analysisPromises)).filter(Boolean);

          // ÉTAPE 4: Filtrer, trier et agréger les résultats
          const relevantCompetitors = allCompetitorAnalyses
            .filter(c => c !== null && c.success && 'isRelevant' in c && c.isRelevant)
            .sort((a, b) => (b as any).relevanceScore - (a as any).relevanceScore)
            .slice(0, Number(nCompetitors));

          const allOpportunities = relevantCompetitors.flatMap(c => 
            (c && 'keywordOpportunities' in c) ? c.keywordOpportunities : []
          );
          const topOpportunities = allOpportunities
            .sort((a, b) => (a.competitorPosition - b.competitorPosition) || (b.volume - a.volume))
            .slice(0, 20);

          return asMcpContent({
            baseHost: { host, overview: baseOverviewResponse.data, keywordsCount: baseKeywordsSet.size },
            competitors: relevantCompetitors,
            keywordOpportunities: topOpportunities,
            summary: {
              analyzedCount: potentialCompetitors.length,
              relevantCount: relevantCompetitors.length,
              opportunitiesFound: allOpportunities.length
            }
          });
        } catch (error: any) {
          logger.error(`Échec de l'analyse concurrentielle: ${error.message}`);
          throw new McpError(ErrorCode.InternalError, `Analyse concurrentielle échouée: ${error.message}`);
        }
      }

      case "babbar_serp_bin_trend": {
        const host = args.host as string;
        const lang = args.lang || DEFAULT_LANG;
        const country = args.country || DEFAULT_COUNTRY;
        const date = args.date || TODAY();
        const binSize = Number(args.binSize ?? 5);
        const maxPos = Number(args.maxPos ?? 100);
        const n = Number(args.n ?? 500);

        const kw = await makeApiCall("/host/keywords", "POST", {
          host,
          lang,
          country,
          date,
          offset: 0,
          n,
          min: 1,
          max: maxPos,
        });
        const list = (kw?.data?.keywords || kw?.data || []) as any[];
        const bins: Record<string, number> = {};
        for (let start = 1; start <= maxPos; start += binSize) {
          const end = Math.min(start + binSize - 1, maxPos);
          bins[`${start}-${end}`] = 0;
        }
        for (const row of list) {
          const pos = Number((row as any).position || (row as any).pos || (row as any).rank || 0);
          if (!pos || pos > maxPos) continue;
          const start = Math.floor((pos - 1) / binSize) * binSize + 1;
          const end = Math.min(start + binSize - 1, maxPos);
          bins[`${start}-${end}`] += 1;
        }
        return asMcpContent({ host, date, bins, total: list.length });
      }

      case "babbar_onsite_quickwins": {
        try {
            logger.info("Analyse des quick wins on-site...");
            const { host, topK = 10 } = args;

            // ÉTAPE 1: Récupérer les données de base (santé, duplication, top pages)
            const [healthResponse, duplicateResponse, topPagesResponse] = await Promise.all([
                makeApiCall("/host/health", "POST", { host }),
                makeApiCall("/host/duplicate", "POST", { host }),
                makeApiCall("/host/pages/top/sv", "POST", { host, limit: topK })
            ]);

            const recommendations: any[] = [];

            // ÉTAPE 2: Analyser la santé technique
            const healthData = healthResponse.data;
            if (healthData.health < 90) {
                recommendations.push({
                    type: "Santé Technique",
                    priority: "High",
                    issue: `Le score de santé est bas (${healthData.health}/100).`,
                    action: `Analyser la répartition des codes HTTP (${healthData.h4xx} erreurs 4xx, ${healthData.h5xx} erreurs 5xx) et corriger les problèmes.`
                });
            }

            // ÉTAPE 3: Analyser le contenu dupliqué (avec le bon seuil)
            const duplicateData = duplicateResponse.data;
            const criticalDuplicates = (duplicateData.pairs || []).filter((p: any) => p.percent_from >= 87);
            if (criticalDuplicates.length > 0) {
                recommendations.push({
                    type: "Contenu Dupliqué",
                    priority: "Medium",
                    issue: `${criticalDuplicates.length} paires de pages avec un taux de duplication critique (>87%).`,
                    action: "Utiliser des balises canonical, réécrire ou fusionner le contenu des pages concernées.",
                    details: criticalDuplicates.slice(0, 5)
                });
            }

            // ÉTAPE 4: Suggérer des optimisations de maillage interne
            const topPages = safeExtractData(topPagesResponse, 'urls');
            const linkingSuggestions: any[] = [];
            for (const page of topPages.slice(0, 3)) { // Limiter les appels API
                const similarLinksResponse = await makeApiCall("/url/similar-links", "POST", { url: page.url });
                const suggestions = safeExtractData(similarLinksResponse, 'urls');
                if (suggestions.length > 0) {
                    linkingSuggestions.push({
                        sourceUrl: page.url,
                        suggestions: suggestions.map(s => ({ targetUrl: s.url, score: s.score }))
                    });
                }
            }
            if (linkingSuggestions.length > 0) {
                recommendations.push({
                    type: "Maillage Interne",
                    priority: "Low",
                    issue: "Des opportunités de liens internes ont été trouvées pour les pages stratégiques.",
                    action: "Ajouter des liens contextuels depuis les pages sources vers les pages cibles suggérées.",
                    details: linkingSuggestions
                });
            }

            return asMcpContent({
                host,
                quickWins: recommendations.sort((a, b) => {
                    const priorities: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
                    return (priorities[b.priority] || 0) - (priorities[a.priority] || 0);
                }),
                summary: {
                    health: healthData,
                    duplicatePairs: duplicateData.pairs?.length || 0,
                    criticalDuplicatePairs: criticalDuplicates.length,
                    topPagesAnalyzed: topPages.length
                }
            });
        } catch (error: any) {
            logger.error(`Échec de l'analyse des quick wins: ${error.message}`);
            throw new McpError(ErrorCode.InternalError, `Analyse on-site échouée: ${error.message}`);
        }
      }

      case "babbar_backlink_opportunities_spotfinder": {
        try {
          logger.info("Backlink opportunities via SpotFinder (FI only)…");

          const {
            host,
            // brief SpotFinder
            content: userContent,
            q,
            lang = DEFAULT_LANG,

            // cibles
            targets: initialTargets = [],
            maxTargets = 18,
            internalPageLimit = 2000,

            // collecte des pages sources côté prospects
            topPagesPerHost = 50,
            sourcesPoolCap = 3000,

            // échantillonnage & FI
            maxCandidatesPerTarget = 80,   // nb max de sources testées par target (FI)
            fiThreshold = 10,              // seuil de FI gardé

            // contexte SERP (facultatif)
            country = DEFAULT_COUNTRY,
            date = TODAY(),

            // concurrence & borne de sortie
            concurrencyFi = 8,
            topLimit = 25,
          } = args;

          // ---------- Helpers locaux ----------
          const extractArray = (res: any, ...keys: string[]): any[] => {
            for (const k of keys) {
              const v = safeExtractData(res, k);
              if (Array.isArray(v)) return v;
              const d = res?.data?.[k];
              if (Array.isArray(d)) return d;
            }
            if (Array.isArray(res?.data)) return res.data;
            return Array.isArray(res) ? res : [];
          };

          const pLimit = (concurrency: number) => {
            let active = 0;
            const queue: Array<() => void> = [];
            const next = () => { active--; if (queue.length) queue.shift()!(); };
            return async function run<T>(fn: () => Promise<T>): Promise<T> {
              if (active >= concurrency) await new Promise<void>(r => queue.push(r));
              active++;
              try { return await fn(); } finally { next(); }
            };
          };

          const fiLimit = pLimit(Number(concurrencyFi));

          const getFi = async (sourceUrl: string, targetUrl: string): Promise<{ fi: number; confidence?: string }> => {
            try {
              const resp = await makeApiCall("/url/fi", "POST", { source: sourceUrl, target: targetUrl });
              const d = resp?.data ?? resp;
              const fi = Number(d?.fi ?? 0);
              const confidence = d?.confidence ?? undefined;
              return { fi: Number.isFinite(fi) ? fi : 0, confidence };
            } catch { return { fi: 0 }; }
          };

          const normalize = (s: string) =>
            String(s).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

          // ---------- Étape 0 : mots-clés du host (pour choisir des targets “faibles”) ----------
          const baseKwResp = await makeApiCall("/host/keywords", "POST", {
            host, lang, country, date, n: 5000, offset: 0,
          });
          const baseKwRows = extractArray(baseKwResp, "keywords");
          type KwRow = { keyword: string; url?: string; rank: number };
          const baseKw: KwRow[] = baseKwRows.map((r: any) => {
            const k = r.keywords ?? r.keyword ?? r.text ?? r.q ?? null;
            const kw = Array.isArray(k) ? k[0] : k;
            const rank = Number(r.rank ?? r.position ?? r.pos ?? Infinity);
            const url = r.url ?? r.page ?? undefined;
            return kw ? { keyword: String(kw), rank, url } : null;
          }).filter(Boolean) as KwRow[];

          // URL -> meilleur rang
          const bestRankByUrl = new Map<string, number>();
          for (const row of baseKw) {
            if (!row.url) continue;
            const prev = bestRankByUrl.get(row.url) ?? Infinity;
            if (row.rank < prev) bestRankByUrl.set(row.url, row.rank);
          }

          // ---------- Étape 1 : Targets (<= maxTargets, sans KW < 5) ----------
          let targets: string[] = Array.isArray(initialTargets) ? [...initialTargets] : [];
          if (targets.length === 0) {
            logger.info("Targets non fournies — sélection auto (pages sans KW < 5, priorisées SV puis PV)…");
            const internalResp = await makeApiCall("/host/pages/internal", "POST", { host, n: Number(internalPageLimit), offset: 0 });
            const internalPages = extractArray(internalResp, "pages", "urls");
            const candidates = internalPages
              .map((p: any) => ({
                url: p.url ?? p.link ?? p.target ?? null,
                sv: Number(p.semanticValue ?? p.sv ?? 0),
                pv: Number(p.pageValue ?? p.pv ?? 0),
              }))
              .filter((p: any) => p.url);

            const filtered = candidates
              .filter((p: any) => {
                const br = bestRankByUrl.get(p.url);
                return !(br !== undefined && br < 5);
              })
              .sort((a: any, b: any) => (b.sv - a.sv) || (b.pv - a.pv));

            targets = Array.from(new Set(filtered.map((x: any) => x.url))).slice(0, Number(maxTargets));
            if (targets.length === 0 && candidates.length) {
              targets = Array.from(new Set(candidates.sort((a: any, b: any) => b.sv - a.sv).map((x: any) => x.url))).slice(0, Number(maxTargets));
            }
          }
          logger.info(`Targets retenues : ${targets.length}`);

          // ---------- Étape 2 : Exclure hosts qui vous lient déjà ----------
          const ourBlResponse = await makeApiCall("/host/backlinks/host", "POST", { host, limit: 5000 });
          const ourRefHosts = new Set(
            extractArray(ourBlResponse, "hosts")
              .map((h: any) => h.host || h.domain || h.name)
              .filter(Boolean)
          );
          logger.info(`${ourRefHosts.size} hosts référents existants exclus.`);

          // ---------- Étape 3 : SpotFinder → Hosts proches sémantiquement ----------
          // Si pas de contenu utilisateur, on fabrique un “brief” depuis nos meilleurs KW
          const sfContent =
            userContent || q ||
            baseKw
              .filter(r => Number.isFinite(r.rank) && r.rank <= 20)
              .slice(0, 100)
              .map(r => r.keyword)
              .join(" ");

          if (!sfContent || !String(sfContent).trim()) {
            throw new McpError(ErrorCode.InvalidParams, "SpotFinder requiert un 'content' non vide (ou que le site possède des KW).");
          }

          const sfResp = await makeApiCall("/host/spotsfinder", "POST", { content: sfContent, lang });
          // Réponses tolérées : { hosts:[{host,score}]} ou { results:[{host,...}]} etc.
          const sfHosts = extractArray(sfResp, "hosts", "results", "items")
            .map((x: any) => ({
              host: x.host || x.similar || x.domain || x.name || null,
              score: Number(x.score ?? x.similarity ?? x.match ?? 0),
            }))
            .filter((x: any) => x.host);

          if (!sfHosts.length) {
            return asMcpContent({
              host, params: { lang, maxTargets, topPagesPerHost, fiThreshold },
              targets,
              opportunities: [],
              summary: { spotfinderHosts: 0, message: "Aucun host compatible retourné par /host/spotsfinder." }
            });
          }

          // ---------- Étape 4 : Pour chaque host SpotFinder, récupérer ses meilleures pages ----------
          // Priorité : Top pages par Semantic Value
          let sources: any[] = [];
          for (const h of sfHosts) {
            try {
              const topResp = await makeApiCall("/host/pages/top/sv", "POST", { host: h.host, limit: Number(topPagesPerHost) });
              const urls = extractArray(topResp, "urls").slice(0, Number(topPagesPerHost));
              sources.push(
                ...urls.map((u: any) => ({
                  url: u.url,
                  host: h.host,
                  semanticValue: Number(u.semanticValue ?? u.sv ?? u.ContribSemanticValue ?? 0),
                  pageValue: Number(u.pageValue ?? u.pv ?? u.ContribPageValue ?? 0),
                  babbarAuthorityScore: Number(u.babbarAuthorityScore ?? u.bas ?? 0),
                  spotfinderScore: h.score,
                }))
              );
            } catch (e) {
              logger.warn(`Top pages failed for ${h.host}: ${e}`);
            }
            if (sources.length >= Number(sourcesPoolCap)) break; // garde-fou
          }

          // Dédup par URL + exclusion des domaines qui nous lient déjà
          const uniqueSources = Array.from(new Map(sources.map(p => [p.url, p])).values())
            .filter(p => p.url && p.host && !ourRefHosts.has(p.host));
          logger.info(`Sources candidates (dédup + exclusion déjà référents) : ${uniqueSources.length}`);

          if (!uniqueSources.length) {
            return asMcpContent({
              host,
              params: { lang, maxTargets, topPagesPerHost, fiThreshold },
              targets,
              opportunities: [],
              summary: { spotfinderHosts: sfHosts.length, sourcesCollected: 0, message: "Aucune source exploitable après filtrage." }
            });
          }

          // ---------- Étape 5 : Échantillonnage par métriques → FI ----------
          type Opp = {
            prospectUrl: string;
            prospectHost: string;
            targetUrl: string;
            inducedStrength: number;
            confidence?: string;
            prospectMetrics: { semanticValue?: number; pageValue?: number; babbarAuthorityScore?: number };
            fromHost: string;
            spotfinderScore?: number;
          };

          const ops: Opp[] = [];

          for (const targetUrl of targets) {
            // On pré-sélectionne les meilleures sources (SV, PV, score spotfinder) pour limiter le coût FI
            const preselected = uniqueSources
              .slice()
              .sort((a, b) =>
                (b.semanticValue ?? 0) - (a.semanticValue ?? 0) ||
                (b.pageValue ?? 0) - (a.pageValue ?? 0) ||
                (b.spotfinderScore ?? 0) - (a.spotfinderScore ?? 0)
              )
              .slice(0, Number(maxCandidatesPerTarget));

            await Promise.all(
              preselected.map((p) =>
                fiLimit(async () => {
                  const { fi, confidence } = await getFi(p.url, targetUrl);
                  if (fi >= Number(fiThreshold)) {
                    ops.push({
                      prospectUrl: p.url,
                      prospectHost: p.host,
                      targetUrl,
                      inducedStrength: fi,
                      confidence,
                      prospectMetrics: {
                        semanticValue: p.semanticValue,
                        pageValue: p.pageValue,
                        babbarAuthorityScore: p.babbarAuthorityScore,
                      },
                      fromHost: p.host,
                      spotfinderScore: p.spotfinderScore,
                    });
                  }
                })
              )
            );
          }

          const opportunities = ops
            .sort((a, b) =>
              b.inducedStrength - a.inducedStrength ||
              (b.spotfinderScore ?? 0) - (a.spotfinderScore ?? 0) ||
              (b.prospectMetrics.semanticValue ?? 0) - (a.prospectMetrics.semanticValue ?? 0)
            )
            .slice(0, Number(topLimit));

          return asMcpContent({
            host,
            params: {
              lang, maxTargets, internalPageLimit,
              topPagesPerHost, sourcesPoolCap,
              maxCandidatesPerTarget, fiThreshold,
              concurrencyFi, topLimit,
              country, date,
              usedContent: sfContent && String(sfContent).slice(0, 120) + (String(sfContent).length > 120 ? "…" : "")
            },
            targets,
            opportunities,
            summary: {
              spotfinderHosts: sfHosts.length,
              sourcesCollected: uniqueSources.length,
              opportunitiesFound: ops.length,
              opportunitiesReturned: opportunities.length,
              note: opportunities.length
                ? `Tri par FI (desc), puis score SpotFinder, puis SV.`
                : `Aucune FI ≥ ${fiThreshold} trouvée avec les paramètres actuels.`
            },
            notes: {
              spotfinder: "POST /host/spotsfinder : renvoie des hosts sémantiquement compatibles avec le contenu fourni.",
              method: "Pour chaque host trouvé, on prend ses meilleures pages (Top SV), on échantillonne par métriques, puis on calcule la FI (sans similarité).",
              rationale: "La Force Induite intègre déjà la pertinence sémantique et la popularité ; on l’utilise comme critère unique."
            }
          });

        } catch (error: any) {
          logger.error(`Échec SpotFinder opportunities (FI only): ${error.message}`);
          throw new McpError(ErrorCode.InternalError, `SpotFinder opportunities failed: ${error.message}`);
        }
      }

      case "babbar_anchor_profile_risk": {
        const host = args.host as string;
        const anchors = await makeApiCall("/host/anchors", "POST", { host });
        const rows = (anchors?.data?.backlinks || []) as Array<{text:string;linkCount:number;percent?:number}>;

        const brandTerms: string[] = ((args.brandTerms as string[]) || []).map((s) => s.toLowerCase());
        const moneyTerms: string[] = ((args.moneyTerms as string[]) || []).map((s) => s.toLowerCase());
        const genericTerms = [
          "ici",
          "cliquez",
          "site",
          "homepage",
          "accueil",
          "www",
          "http",
          "https",
          "voir",
          "lire",
          "page",
          "article",
        ];

        const totalLinkCount = rows.reduce((s,a) => s + Number(a.linkCount || 0), 0);
        const counters = { brand: 0, money: 0, generic: 0, other: 0, total: totalLinkCount };
        const items: Array<{text:string;linkCount:number;percent:number;bucket:string;risk?:'HIGH'|'OK'}> = [];
        for (const a of rows) {
          const text = String(a.text || "").toLowerCase().trim();
          const count = Number(a.linkCount || 0);
          if (!text || !count) continue;

          const isBrand = brandTerms.some((b) => text.includes(b));
          const isMoney = moneyTerms.some((m) => text.includes(m));
          const isGeneric = genericTerms.some((g) => text.includes(g));
          let bucket: 'brand'|'money'|'generic'|'other' = 'other';
          if (isBrand) bucket = 'brand';
          else if (isMoney) bucket = 'money';
          else if (isGeneric) bucket = 'generic';
          counters[bucket] += count;
          const pct = totalLinkCount ? (count / totalLinkCount) * 100 : (a.percent ?? 0);
          items.push({ text, linkCount: count, percent: Math.round(pct*100)/100, bucket });
        }

        const riskyAnchors = items
          .filter(i => i.bucket !== 'brand' && i.percent >= 5)
          .sort((a,b)=> b.percent - a.percent);
        const ratios: Record<string, number> = {};
        (['brand','money','generic','other'] as const).forEach(k => {
          ratios[k] = counters.total ? counters[k] / counters.total : 0;
        });
        return asMcpContent({
          host,
          totals:{totalLinkCount: counters.total},
          distribution: counters,
          ratios,
          thresholdPercent: 5,
          riskyAnchors: riskyAnchors.slice(0, 50)
        });
      }

      case "babbar_content_gap": {
        try {
          const host = String(args.host);
          const lang = args.lang || DEFAULT_LANG;
          const country = args.country || DEFAULT_COUNTRY;
          const date = args.date || TODAY();

          // Paramètres optionnels
          const nCompetitors = Number(args.nCompetitors ?? 10);
          const nKeywordsPerSite = Number(args.nKeywordsPerSite ?? 1000);
          const positionThreshold = Number(args.positionThreshold ?? 10); // seuil "concurrent rank <= 10"
          const excludeCompetitorBrand = Boolean(args.excludeCompetitorBrand ?? true);
          const seeds: string[] = Array.isArray(args.seeds) ? args.seeds : [];

          const normalize = (s: string) =>
            String(s)
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{Diacritic}/gu, "")
              .replace(/\s+/g, " ")
              .trim();

          const seedMatchers = seeds.map((s) => normalize(s));

          const isSeedMatched = (kwNorm: string) =>
            seedMatchers.length === 0
              ? true
              : seedMatchers.some((needle) => kwNorm.includes(needle));

          // Heuristique simple pour repérer des brand terms d'un host concurrent
          const brandTokensFromHost = (h: string): string[] => {
            try {
              // ex: "www.example-shop.co.uk" -> ["example", "shop"]
              const hostname = h.replace(/^https?:\/\//, "").replace(/\/.*/, "");
              const parts = hostname.split(".");
              // on enlève TLD et sous-domaines trop génériques
              const tlds = new Set(["com", "net", "org", "io", "co", "uk", "fr", "de", "es", "it", "nl", "us", "ca"]);
              const commons = new Set(["www", "m", "blog", "shop", "store"]);
              const keep = parts.filter((p) => !tlds.has(p) && !commons.has(p));
              // éclate par tiret
              const tokens = keep.flatMap((p) => p.split("-"));
              return Array.from(new Set(tokens.map(normalize).filter(Boolean)));
            } catch {
              return [];
            }
          };

          const isBrandedFor = (kwNorm: string, brandTokens: string[]) => {
            if (brandTokens.length === 0) return false;
            // Exclut si tout le terme est clairement "marque" (contient l’un des tokens distinctifs)
            return brandTokens.some((t) => t.length >= 3 && kwNorm.includes(t));
          };

          // ---- 1) KW du site analysé (base) ----
          const baseKwResp = await makeApiCall("/host/keywords", "POST", {
            host,
            lang,
            country,
            date,
            n: nKeywordsPerSite,
            offset: 0,
            // on récupère large, le filtrage viendra après
          });
          const baseEntries = safeExtractData(baseKwResp, "keywords") || [];
          type KwRow = { keyword: string; rank: number; url?: string; feature?: string };
          const extractKw = (rows: any[]): KwRow[] =>
            rows
              .map((r: any) => {
                const k =
                  r.keywords ?? r.keyword ?? r.text ?? r.q ?? r.term ?? r.k ?? null;
                const keyword = Array.isArray(k) ? k[0] : k;
                const rank = Number(r.rank ?? r.position ?? r.pos ?? Infinity);
                const url = r.url ?? r.page ?? undefined;
                const feature = r.feature ?? r.type ?? undefined;
                return keyword ? { keyword: String(keyword), rank, url, feature } : null;
              })
              .filter(Boolean) as KwRow[];

          const baseKwList: KwRow[] = extractKw(baseEntries);
          // Map KW normalisé -> meilleure position observée pour le site analysé
          const baseBestRank = new Map<string, number>();
          for (const row of baseKwList) {
            const k = normalize(row.keyword);
            const prev = baseBestRank.get(k) ?? Infinity;
            if (row.rank && row.rank < prev) baseBestRank.set(k, row.rank);
          }

          // ---- 2) Concurrents sémantiques ----
          const similarResp = await makeApiCall("/host/similar", "POST", {
            host,
            n: nCompetitors * 2, // on prend plus, puis on filtre
          });
          const similars = safeExtractData(similarResp, "hosts") || [];
          // structure tolérante: {host|similar, score}
          const competitorsAll: { host: string; score: number; brandTokens: string[] }[] =
            similars
              .map((x: any) => {
                const chost = x.host || x.similar || x.domain || null;
                const score = Number(x.score ?? 0);
                return chost
                  ? { host: String(chost), score, brandTokens: brandTokensFromHost(String(chost)) }
                  : null;
              })
              .filter(Boolean) as any[];

          // Tri par score décroissant et on garde les top nCompetitors
          const competitors = competitorsAll
            .sort((a, b) => (b.score - a.score))
            .slice(0, nCompetitors);

          if (competitors.length === 0) {
            return asMcpContent({
              host,
              message: "No competitors found by /host/similar.",
              contentGap: [],
            });
          }

          // ---- 3) Récup KW concurrents (en parallèle) ----
          const compResults = await Promise.all(
            competitors.map(async (c) => {
              try {
                const resp = await makeApiCall("/host/keywords", "POST", {
                  host: c.host,
                  lang,
                  country,
                  date,
                  n: nKeywordsPerSite,
                  offset: 0,
                });
                const rows = safeExtractData(resp, "keywords") || [];
                const list = extractKw(rows)
                  // on garde uniquement les positions "gagnantes" (<= threshold)
                  .filter((r) => Number.isFinite(r.rank) && r.rank <= positionThreshold);
                return { ...c, keywords: list, success: true };
              } catch (e: any) {
                logger.warn(`KW fetch failed for competitor ${c.host}: ${e?.message || e}`);
                return { ...c, keywords: [], success: false, error: e?.message || String(e) };
              }
            })
          );

          // ---- 4) Différence (content gap) ----
          // Agrégat cross-concurrents : keywordNorm -> infos
          type GapHit = { competitor: string; position: number; url?: string };
          const gapMap = new Map<
            string,
            { keyword: string; hits: GapHit[]; bestCompetitorPosition: number; numCompetitorsWinning: number }
          >();

          for (const comp of compResults) {
            if (!comp.success || !Array.isArray(comp.keywords)) continue;
            for (const row of comp.keywords) {
              const kwNorm = normalize(row.keyword);
              if (!kwNorm || !isSeedMatched(kwNorm)) continue;

              // Exclusion des KW déjà gagnés par le site (rank <= threshold)
              const baseRank = baseBestRank.get(kwNorm);
              if (baseRank !== undefined && baseRank <= positionThreshold) continue;

              // Exclusion des brand terms du concurrent si demandé
              if (excludeCompetitorBrand && isBrandedFor(kwNorm, comp.brandTokens)) continue;

              // OK, c'est un gap : le concurrent est gagnant sur ce KW et pas nous
              const prev = gapMap.get(kwNorm);
              const hit: GapHit = { competitor: comp.host, position: row.rank, url: row.url };
              if (!prev) {
                gapMap.set(kwNorm, {
                  keyword: row.keyword,
                  hits: [hit],
                  bestCompetitorPosition: row.rank,
                  numCompetitorsWinning: 1,
                });
              } else {
                prev.hits.push(hit);
                if (row.rank < prev.bestCompetitorPosition) prev.bestCompetitorPosition = row.rank;
                prev.numCompetitorsWinning = prev.hits.length;
              }
            }
          }

          // ---- 5) Mise en forme & tri ----
          const gapList = Array.from(gapMap.values())
            .sort(
              (a, b) =>
                a.bestCompetitorPosition - b.bestCompetitorPosition ||
                b.numCompetitorsWinning - a.numCompetitorsWinning ||
                a.keyword.localeCompare(b.keyword)
            );

          // Optionnel: limite de résultats retournés
          const nResults = Number(args.nResults ?? 300);
          const limited = gapList.slice(0, nResults);

          return asMcpContent({
            baseHost: host,
            params: {
              lang,
              country,
              date,
              nCompetitors,
              nKeywordsPerSite,
              positionThreshold,
              excludeCompetitorBrand,
              seeds,
              nResults,
            },
            summary: {
              baseKeywords: baseKwList.length,
              competitorsRequested: nCompetitors,
              competitorsFetched: compResults.filter((c) => c.success).length,
              contentGapCount: gapList.length,
              returned: limited.length,
            },
            contentGap: limited.map((g) => ({
              keyword: g.keyword,
              bestCompetitorPosition: g.bestCompetitorPosition,
              numCompetitorsWinning: g.numCompetitorsWinning,
              competitors: g.hits
                .sort((x, y) => x.position - y.position)
                .slice(0, 10), // on limite la liste détaillée
            })),
          });
        } catch (error: any) {
          logger.error(`Content gap failed: ${error?.message || error}`);
          throw new McpError(ErrorCode.InternalError, `babbar_content_gap failed: ${error?.message || error}`);
        }
      }

      case "babbar_language_localization_audit": {
        const host = args.host as string;
        const lang = args.lang || DEFAULT_LANG;
        const country = args.country || DEFAULT_COUNTRY;
        const date = args.date || TODAY();
        const [langs, kw] = await Promise.all([
          makeApiCall("/host/lang", "POST", { host }),
          makeApiCall("/host/keywords", "POST", { host, lang, country, date, n: 2000, offset: 0, min: 1, max: 100 }),
        ]);
        return asMcpContent({ host, detectedLanguages: langs?.data || langs, keywordsSample: kw?.data || kw });
      }

      case "babbar_duplicate_map": {
        const host = args.host as string;
        const includeKeywords = !!args.includeKeywords;
        const dup = await makeApiCall("/host/duplicate", "POST", { host });

        let kw: any = null;
        if (includeKeywords) {
          kw = await makeApiCall("/host/keywords", "POST", {
            host,
            lang: args.lang || DEFAULT_LANG,
            country: args.country || DEFAULT_COUNTRY,
            date: args.date || TODAY(),
            n: 2000,
            offset: 0,
            min: 1,
            max: 100,
          });
        }
        return asMcpContent({ host, duplicate: dup?.data || dup, keywords: includeKeywords ? (kw?.data || kw) : undefined });
      }

      case "babbar_fetch_status_audit": {
        const host = args.host as string;
        const limit = args.limit ?? 5000;
        const offset = args.offset ?? 0;

        const res = await makeApiCall("/host/fetches/list", "POST", { host, limit, offset });
        const rows = (res?.data?.fetches || res?.data || []) as any[];
        const counts: Record<string, number> = {};
        for (const r of rows) {
          const code = String((r as any).status || (r as any).code || "unknown");
          counts[code] = (counts[code] || 0) + 1;
        }
        return asMcpContent({ host, counts, total: rows.length, sample: rows.slice(0, 50) });
      }

      case "babbar_ip_neighbourhood_audit": {
        const host = args.host as string;
        const [ip, neighbours] = await Promise.all([
          makeApiCall("/host/ip", "POST", { host }),
          makeApiCall("/host/neighbours", "POST", { host }),
        ]);
        return asMcpContent({ host, ip: ip?.data || ip, neighbours: neighbours?.data || neighbours });
      }

      case "babbar_induced_strength_batch": {
        const pairs = args.pairs as Array<{ source: string; target: string }>;
        const results: any[] = [];
        for (const { source, target } of pairs) {
          try {
            const fi = await makeApiCall("/url/fi", "POST", { source, target });
            results.push({ source, target, inducedStrength: fi?.data || fi, success: true });
          } catch (e: any) {
            results.push({ source, target, success: false, error: e.message });
          }
        }
        return asMcpContent({ count: results.length, results });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
    }
  } catch (error: any) {
    logger.error(`Tool execution failed: ${error.message}`);

    // ✅ AMÉLIORATION : Retourner l'erreur dans le bon format MCP
    throw new McpError(ErrorCode.InternalError, error.message || "Tool execution failed");
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Babbar MCP Server started successfully");
}

main().catch((error) => {
  logger.error("Failed to start server:", error);
  process.exit(1);
});

