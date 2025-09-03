# Babbar — Metrics Dictionary

These definitions describe the metrics exposed by Babbar.  
Reminder: most metrics are computed at the page (URL) level and then aggregated at the host and domain levels.  
The BAS is a popularity score weighted by semantic coherence and integrating an anti-spam component.

> Note: Page Trust (PT) measures a trust score similar to TrustRank; it is not an “authority” metric directly used by Google for ranking.  
> Duplication: the “similarity percentage” in the duplication module is actually a duplication percentage computed via RollingHash (Rabin–Karp), which is more accurate than SimHash. It is **not** a semantic similarity. Any value under 87% means no duplication.  
> Risk threshold: from 87% and above, we consider there is a duplication issue (risk of de-indexation).

To assess the value of a backlink, the **only relevant metric is the Induced Strength (fi)** of the pair of URLs (link source → link target).  
Induced Strength is computed by Babbar on demand, taking into account both the popularity of the source page and the semantic relevance of the link.  
You must always query the Babbar API to obtain this metric.

## Metrics Table

| Metric | Definition |
|---|---|
| Page Value (pageValue) | Popularity of a page (reasonable random surfer), scale 0–100. |
| Page Trust (pageTrust) | Trust of a page (TrustRank-type), scale 0–100. This metric is **not** useful for authority calculation in the sense of a direct Google ranking criterion. |
| Page Semantic Value (semanticValue) | Popularity of a page weighted by the semantic coherence of its links, 0–100. |
| Babbar Authority Score (babbarAuthorityScore) | Synthetic Babbar authority score (0–100). Popularity (reasonable random surfer) of a page weighted by semantic coherence and with an anti-spam component. According to Babbar studies, this metric correlates best with Google rankings. |
| Host Value (hostValue) | Aggregated popularity at host level (0–100). |
| Host Trust (hostTrust) | Aggregated trust at host level (0–100). |
| Host Semantic Value (semanticValue) | Aggregated SV at host level (0–100). |
| Domain Value (domainValue) | Aggregated popularity at domain level (0–100). |
| Domain Trust (domainTrust) | Aggregated trust at domain level (0–100). |
| Domain Semantic Value (semanticValue) | Aggregated SV at domain level (0–100). |
| Internal Page Value (internalElementValue) | Internal popularity of a page within its host (similar to internal PageRank). |
| ContribPageValue | Contribution of a page to HV/DV (in %). |
| ContribPageTrust | Contribution of a page to HT/DT (in %). |
| ContribSemanticValue | Contribution of a page to the host/domain SV (in %). |
| ContribInternalElementValue | Contribution of a page to the host IPV (in %). |
| numViewsTotal | Total number of known pages for the host/domain. |
| numViewsUsed | Number of pages used for top calculation. |
| backlinks.linkCount | Total number of backlinks. |
| backlinks.anchorCount | Number of distinct anchors in backlinks. |
| backlinks.hostCount | Number of referring hosts. Useful for authority analysis. |
| backlinks.domainCount | Number of referring domains. |
| backlinks.ipCount | Number of referring IP addresses. |
| backlinks.asCount | Number of referring AS (autonomous systems). |
| backlinks.languageCounters.count | Backlinks distribution by language (count). |
| backlinks.countryCounters.count | Backlinks distribution by country (count). |
| numBacklinksUsed | Number of backlinks considered in the current response. |
| numBacklinksTotal | Total number of known backlinks. |
| numBacklinksCurrent | Number of backlinks returned in this page (paginated list). |
| offset | Current pagination offset. |
| n | Number of requested results per page (paginated list). |
| links.semanticValue | SV of the backlink source page (0–100). |
| links.pageTrust | PT of the backlink source page (0–100). |
| links.pageValue | PV of the backlink source page (0–100). |
| links.babbarAuthorityScore | BAS of the backlink source page (0–100). |
| anchors.linkCount | Number of links using the anchor. |
| anchors.hostCount | Number of referring hosts using the anchor. |
| anchors.domainCount | Number of referring domains using the anchor. |
| anchors.ipCount | Number of referring IPs using the anchor. |
| anchors.percent | Share of anchor usage (in %). |
| health | HTTP health score (0–100). |
| h2xx | Number of 2xx URLs. |
| h3xx | Number of 3xx URLs. |
| h4xx | Number of 4xx URLs. |
| h5xx | Number of 5xx URLs. |
| hxxx | Number of distinct URLs crawled/fetched. |
| hfailed | Number of URLs failed to fetch. |
| hRobotsDenied | Number of URLs blocked by robots.txt (if provided). |
| backlinksExternal | Number of external backlinks pointing to the URL. |
| backlinksInternal | Number of internal backlinks pointing to the URL. |
| numOutLinksInt | Number of outbound links to the same host. |
| numOutLinksExt | Number of outbound links to other hosts. |
| fetchTimeToFirstByte | TTFB without DNS (ms). |
| contentLength | Content size (bytes). |
| httpStatus | HTTP status code of the page. |
| languages.percent | Share of pages per language (in %). |
| categories.score | Category confidence score (per language). |
| rank | SERP rank (position) of the URL. |
| subRank | Sub-rank within a SERP feature block (e.g. organic position inside a carousel). |
| semanticSimilarity | Semantic similarity between two URLs (0–100). |
| similar.score | Proximity score between pages (same host) via proprietary algorithm; not to be confused with RollingHash duplication %. |
| neighbours.links.value | Link intensity/proximity between two hosts in the neighborhood graph. |
| neighbours.nodes.group | Cluster group of the node (host). |
| percent_from | Start of RollingHash duplication % interval (Rabin–Karp) — problematic if overlapping 87%+. |
| percent_to | End of RollingHash duplication % interval (Rabin–Karp) — problematic if overlapping 87%+. |
| pairs | Number of URL pairs in the bucket (RollingHash/Rabin–Karp). Buckets ≥ 87% must be prioritized. This is not a similarity score, and any value < 87% means no duplication. |
| fi | Induced Strength of an existing/simulated backlink (or 'n/a'). |
| confidence | Confidence level of the Induced Strength calculation (LOW/HIGH). |
| view | Indicates whether the entity has been seen (0/1). |
| knownUrls | Number of known URLs for the entity (host/domain). |
| ip (count) | Number of known IPs (derivable from the IP list). |
| fetches.http | HTTP status code for each listed page. |

---

## Business Reference Table

| Action | Definition |
|---|---|
| Competitive Analysis | Identifying similar sites with overlapping keywords. |
| Content Gap | Identifying keywords ranked by competitors (via `/host/keywords`) with positions ≤ 10, that are missing from the analyzed site. |
| Backlink Analysis | Assessment using Induced Strength (fi) of the pair (source → target) to compare the value of existing backlinks. |
| Backlink Opportunities | After identifying competitors and extracting their backlinks, simulate the Induced Strength of backlinks that could be created by using competitor sources pointing to the analyzed site’s URLs. **No use of Semantic Similarity: only fi is relevant.** |
| Keyword Opportunities | For an identical keyword present on both the analyzed site and competitors: opportunity if the competitor ranks ≤ 10 and the analyzed site ranks > 10 (excluding competitor brand keywords). |
| Brand Keyword | A keyword that refers specifically to the brand: e.g., “Pim’s” is a brand query for LU. |

---

_Last updated: generated from the internal Babbar repository (MCP)._
