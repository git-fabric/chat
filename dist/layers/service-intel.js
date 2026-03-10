/**
 * Service Intelligence — deterministic briefing system
 *
 * Generates structured 11-section service briefings by merging
 * static operational profiles with live MCP telemetry.
 * Zero LLM involvement — all reports are code-generated.
 *
 * Three modes:
 *   overview  — bare name or "service <name>"
 *   inspect   — "inspect <name>" — deep pull, all tools
 *   map       — "map <name>" — ASCII dependency tree
 */
// ── Service Profiles ─────────────────────────────────────────────────────────
const PROFILES = {
    unifi: {
        name: "UniFi Network",
        fabricApp: "unifi",
        purpose: "Centralized network management — APs, switches, gateways, PDUs",
        role: "Layer 1-3 network infrastructure for the entire homelab",
        criticality: "Critical",
        architecture: {
            deploymentType: "Kubernetes (fabric-unifi pod in fabric-sdk)",
            hostLocation: "k3s cluster, managed by UDM Pro at 23.87.116.165",
            networkDeps: ["VLAN management network", "UI.com Cloud API"],
            storageDeps: ["UDM Pro local storage"],
            relatedServices: ["Cloudflare (external DNS)", "Tailscale (overlay VPN)", "Proxmox (VM networking)"],
        },
        security: {
            authMethod: "UI.com Cloud API key",
            exposureSurface: "UDM Pro WAN port exposed, management via UI.com cloud",
            knownRisks: ["Cloud API dependency — outage blocks management", "Firmware updates can disrupt network"],
            integrations: ["Cloudflare DNS", "Tailscale ACL"],
        },
        observability: {
            monitoring: ["Prometheus via kube-prometheus-stack", "UniFi built-in dashboard"],
            logging: ["UDM Pro syslog"],
            metrics: "Device status, client counts, bandwidth via MCP tools",
            alerting: "Fabric pipeline: network-audit (3-network-audit)",
        },
        dependencies: {
            upstream: ["UI.com Cloud API", "ISP (Cable Internet)"],
            downstream: ["All services — everything depends on network", "Proxmox VM networking", "k3s pod networking"],
        },
        failureModes: [
            { issue: "AP offline", troubleshooting: "Check PoE power from switch, verify AP LED status, try power cycle via PDU" },
            { issue: "Cloud API unreachable", troubleshooting: "Verify internet connectivity, check UI.com status page, fall back to local management" },
            { issue: "Firmware update failure", troubleshooting: "Do not force reboot — wait for rollback, check firmware status via unifi_list_devices" },
        ],
        recommendations: [
            "Schedule firmware updates during maintenance windows",
            "Monitor offline device count — alert if > 0 for > 5 minutes",
            "Keep spare AP for quick swap on failure",
            "Document VLAN topology in ADR",
        ],
    },
    proxmox: {
        name: "Proxmox VE",
        fabricApp: "proxmox",
        purpose: "Type-1 hypervisor — VMs and LXC containers",
        role: "Foundation layer — hosts all k3s nodes and standalone VMs",
        criticality: "Critical",
        architecture: {
            deploymentType: "Bare metal hypervisor (pve01)",
            hostLocation: "Physical server — single node cluster",
            networkDeps: ["UniFi managed network", "VLAN bridging"],
            storageDeps: ["Local ZFS", "Longhorn (for k3s PVCs)"],
            relatedServices: ["k3s cluster (all nodes are Proxmox VMs)", "Longhorn (distributed storage)", "ArgoCD (GitOps)"],
        },
        security: {
            authMethod: "Proxmox API token (PVEAPIToken)",
            exposureSurface: "Web UI on port 8006, API only via Tailscale",
            knownRisks: ["Single physical host — hardware failure takes everything down", "RAM overcommit risk with 64Gi total"],
            integrations: ["Tailscale (remote access)", "Sandfly (host security scanning)"],
        },
        observability: {
            monitoring: ["Prometheus via kube-prometheus-stack", "Proxmox built-in dashboard"],
            logging: ["Proxmox syslog", "journald"],
            metrics: "Node CPU/RAM/disk, VM status via MCP tools",
            alerting: "Fabric pipeline: proxmox-k8s (4-proxmox-k8s)",
        },
        dependencies: {
            upstream: ["Physical hardware", "UniFi network", "Power (USP PDU Pro)"],
            downstream: ["k3s cluster (all 5 nodes)", "All fabric apps (via k3s)", "Longhorn storage"],
        },
        failureModes: [
            { issue: "Node unresponsive", troubleshooting: "Check IPMI/iDRAC if available, verify network via UniFi, physical power cycle as last resort" },
            { issue: "VM stuck in locked state", troubleshooting: "qm unlock <vmid> on PVE shell, check task log for stuck operations" },
            { issue: "Storage pool full", troubleshooting: "Check ZFS usage, remove old snapshots, expand pool if possible" },
            { issue: "RAM exhaustion", troubleshooting: "Check VM memory allocation vs actual usage — current: 2 masters (8Gi) + 3 workers (10Gi) = 46Gi of 64Gi" },
        ],
        recommendations: [
            "Set up automated VM snapshots before k3s upgrades",
            "Monitor ZFS pool health and scrub schedule",
            "Consider adding second physical node for HA",
            "Document VM-to-k3s node mapping",
        ],
    },
    k8s: {
        name: "Kubernetes (k3s)",
        fabricApp: "k8s",
        purpose: "Container orchestration — all fabric apps and services",
        role: "Runtime platform for the entire fabric stack",
        criticality: "Critical",
        architecture: {
            deploymentType: "k3s lightweight Kubernetes on Proxmox VMs",
            hostLocation: "2 masters (8Gi RAM) + 3 workers (10Gi RAM) on pve01",
            networkDeps: ["UniFi network", "Tailscale (kubectl access)", "Traefik ingress"],
            storageDeps: ["Longhorn (distributed block storage)", "longhorn-single StorageClass"],
            relatedServices: ["ArgoCD (GitOps sync)", "Longhorn (PVCs)", "Traefik (ingress)", "Prometheus (monitoring)", "All fabric apps"],
        },
        security: {
            authMethod: "kubeconfig with TLS client certs",
            exposureSurface: "API server on masters, ingress via Traefik + Cloudflare tunnel",
            knownRisks: ["2-master etcd — losing either breaks quorum", "Worker memory pressure with many pods"],
            integrations: ["Tailscale (remote kubectl)", "Cloudflare (ingress DNS)", "Sandfly (node scanning)"],
        },
        observability: {
            monitoring: ["kube-prometheus-stack (Prometheus + Grafana)", "ArgoCD dashboard"],
            logging: ["Pod logs via kubectl/MCP", "Longhorn UI"],
            metrics: "Full cluster metrics via Prometheus, pod status via MCP tools",
            alerting: "Prometheus alertmanager, fabric pipeline: proxmox-k8s",
        },
        dependencies: {
            upstream: ["Proxmox (VM hosts)", "UniFi (network)", "Longhorn (storage)"],
            downstream: ["All fabric apps", "Gateway", "Chat", "Pipelines", "ArgoCD apps"],
        },
        failureModes: [
            { issue: "etcd quorum loss", troubleshooting: "With 2 masters, losing either means no quorum. Restore from etcd snapshot or rebuild." },
            { issue: "Pod eviction from memory pressure", troubleshooting: "Check node memory with k8s_list_nodes, identify heavy pods, adjust resource limits" },
            { issue: "Longhorn volume degraded", troubleshooting: "Check Longhorn dashboard, verify replica count, ensure nodes have disk space" },
            { issue: "ArgoCD sync failed", troubleshooting: "Check k8s_list_argocd_apps for sync status, review diff, force sync if safe" },
            { issue: "Ingress not routing", troubleshooting: "Check k8s_list_ingress_routes, verify Traefik pods running, check Cloudflare DNS" },
        ],
        recommendations: [
            "Monitor etcd health — consider adding 3rd master for quorum safety",
            "Set resource requests/limits on all pods to prevent noisy neighbors",
            "Regular Longhorn volume health checks",
            "Automate k3s version upgrades with system-upgrade-controller",
            "Document namespace-to-service mapping",
        ],
    },
    cloudflare: {
        name: "Cloudflare",
        fabricApp: "cloudflare",
        purpose: "DNS management, CDN, cache, and edge security",
        role: "External DNS and ingress protection for public-facing services",
        criticality: "High",
        architecture: {
            deploymentType: "External SaaS + Kubernetes MCP server (fabric-cloudflare)",
            hostLocation: "Cloudflare edge network, MCP server in k3s",
            networkDeps: ["Internet connectivity", "UniFi WAN"],
            storageDeps: ["Cloudflare KV (edge storage)"],
            relatedServices: ["UniFi (WAN connectivity)", "k3s Traefik (ingress target)", "Tailscale (alternative access)"],
        },
        security: {
            authMethod: "Cloudflare API token",
            exposureSurface: "Public DNS records, Cloudflare dashboard",
            knownRisks: ["DNS misconfiguration can expose internal services", "API token compromise = full DNS control"],
            integrations: ["UniFi DDNS", "Traefik ingress", "Let's Encrypt certificates"],
        },
        observability: {
            monitoring: ["Cloudflare analytics dashboard"],
            logging: ["Cloudflare audit log"],
            metrics: "Zone analytics (requests, bandwidth, threats) via MCP tools",
            alerting: "Cloudflare built-in alerts",
        },
        dependencies: {
            upstream: ["Internet connectivity", "Cloudflare SaaS availability"],
            downstream: ["All public-facing services", "DNS resolution for external access"],
        },
        failureModes: [
            { issue: "DNS propagation delay", troubleshooting: "Check TTL settings, verify record with cf_list_dns_records, use dig to test" },
            { issue: "Cache serving stale content", troubleshooting: "Purge cache via cf_purge_cache tool" },
            { issue: "Zone not resolving", troubleshooting: "Check zone status with cf_list_zones, verify nameserver delegation" },
        ],
        recommendations: [
            "Use proxied records (orange cloud) for DDoS protection",
            "Set reasonable TTLs — 300s for dynamic, 3600s for static",
            "Rotate API tokens periodically",
            "Monitor zone analytics for unusual traffic patterns",
        ],
    },
    tailscale: {
        name: "Tailscale",
        fabricApp: "tailscale",
        purpose: "Zero-config WireGuard mesh VPN",
        role: "Secure remote access to all homelab services",
        criticality: "High",
        architecture: {
            deploymentType: "SaaS coordination + local agents on each device",
            hostLocation: "Tailscale relay in k3s (subnet router), agents on all nodes",
            networkDeps: ["Internet for coordination", "WireGuard UDP"],
            storageDeps: ["None — stateless mesh"],
            relatedServices: ["k3s (subnet router pod)", "Proxmox (node access)", "UniFi (network layer)"],
        },
        security: {
            authMethod: "Tailscale API key + device auth",
            exposureSurface: "WireGuard encrypted tunnel only — no open ports",
            knownRisks: ["Tailscale coordination server dependency", "Device key compromise"],
            integrations: ["MagicDNS for internal resolution", "ACL policies for access control"],
        },
        observability: {
            monitoring: ["Tailscale admin console"],
            logging: ["Tailscale device activity logs"],
            metrics: "Device count, auth status, exit nodes via MCP tools",
            alerting: "Manual — check ts_health periodically",
        },
        dependencies: {
            upstream: ["Tailscale SaaS (coordination server)", "Internet"],
            downstream: ["Remote kubectl access", "Remote Proxmox access", "Mobile device access"],
        },
        failureModes: [
            { issue: "Device not connecting", troubleshooting: "Check device auth status with ts_list_devices, re-authorize if needed" },
            { issue: "Subnet routes not working", troubleshooting: "Verify routes with ts_get_device_routes, check subnet router pod in k3s" },
            { issue: "MagicDNS not resolving", troubleshooting: "Check DNS config with ts_get_dns, verify MagicDNS is enabled" },
        ],
        recommendations: [
            "Enable MagicDNS for clean internal hostnames",
            "Use ACL tags to segment access (admin vs readonly)",
            "Keep auth keys rotated",
            "Document subnet routes and exit node topology",
        ],
    },
    sandfly: {
        name: "Sandfly Security",
        fabricApp: "sandfly",
        purpose: "Agentless Linux intrusion detection and incident response",
        role: "Security scanning across all Linux hosts",
        criticality: "High",
        architecture: {
            deploymentType: "Kubernetes (sandfly server + node pods)",
            hostLocation: "k3s cluster, scanning all k3s nodes and Proxmox host",
            networkDeps: ["SSH access to target hosts", "k3s internal network"],
            storageDeps: ["PostgreSQL (sandfly state)", "Longhorn PVC"],
            relatedServices: ["Proxmox (scan target)", "k3s nodes (scan targets)", "CVE (vulnerability context)"],
        },
        security: {
            authMethod: "Sandfly admin credentials + SSH keys for scanning",
            exposureSurface: "Web UI via ingress, SSH scanning from node pods",
            knownRisks: ["SSH key management for scan targets", "False positives in containerized environments"],
            integrations: ["CVE fabric app (vulnerability correlation)", "Tailscale (secure access to UI)"],
        },
        observability: {
            monitoring: ["Sandfly built-in dashboard", "Prometheus metrics"],
            logging: ["Sandfly scan logs", "PostgreSQL logs"],
            metrics: "Alert count, scan results, host status via MCP tools",
            alerting: "Fabric pipeline: security-triage (1-security-triage)",
        },
        dependencies: {
            upstream: ["SSH access to scan targets", "PostgreSQL database"],
            downstream: ["Security alerts feed into CVE triage", "Fabric pipelines for automated response"],
        },
        failureModes: [
            { issue: "Scan target unreachable", troubleshooting: "Verify SSH connectivity, check Sandfly credential config, verify network path" },
            { issue: "High alert volume", troubleshooting: "Check sandfly_get_alerts, triage by severity, check for known false positives in container envs" },
            { issue: "Database connection lost", troubleshooting: "Check PostgreSQL pod status, verify PVC health" },
        ],
        recommendations: [
            "Schedule scans during low-traffic windows",
            "Tune false positive thresholds for containerized workloads",
            "Integrate alert feed with Slack/notification pipeline",
            "Regular credential rotation for scan SSH keys",
        ],
    },
    cve: {
        name: "CVE Detection & Remediation",
        fabricApp: "cve",
        purpose: "Scan, enrich, triage, and fix vulnerabilities across managed repos",
        role: "Automated vulnerability management pipeline",
        criticality: "Medium",
        architecture: {
            deploymentType: "Kubernetes (fabric-cve pod) + GitHub Actions workflows",
            hostLocation: "k3s cluster + GitHub-hosted runners",
            networkDeps: ["GitHub API", "NVD/CVE databases", "Internet for vulnerability feeds"],
            storageDeps: ["fabric-state repo (queue state)", "Qdrant (vector search for CVE context)"],
            relatedServices: ["Git (PR creation for fixes)", "Sandfly (security context)", "GitHub Actions (scan triggers)"],
        },
        security: {
            authMethod: "GitHub App token (fabric-ctrl)",
            exposureSurface: "GitHub API only — no direct network exposure",
            knownRisks: ["NVD rate limits", "False positive CVEs in dependency trees"],
            integrations: ["GitHub Security Advisories", "fabric-ctrl (GitHub App identity)"],
        },
        observability: {
            monitoring: ["GitHub Actions run status"],
            logging: ["GitHub Actions logs", "fabric-state queue history"],
            metrics: "Queue stats, scan counts via MCP tools",
            alerting: "GitHub Actions failure notifications",
        },
        dependencies: {
            upstream: ["NVD/CVE databases", "GitHub API", "fabric-state repo"],
            downstream: ["Git fabric app (PR creation)", "Developer notification"],
        },
        failureModes: [
            { issue: "CVE pod crashing", troubleshooting: "Check pod logs with k8s_get_pod_logs, verify environment variables and API keys" },
            { issue: "Scan queue stuck", troubleshooting: "Check cve_queue_stats, verify fabric-state repo access" },
            { issue: "NVD API rate limited", troubleshooting: "Back off scan frequency, check NVD API key configuration" },
        ],
        recommendations: [
            "Set up NVD API key for higher rate limits",
            "Prioritize CVEs by CVSS score and exploitability",
            "Auto-create PRs for patch-level dependency updates",
            "Regular triage of false positives to reduce noise",
        ],
    },
    git: {
        name: "Git Operations",
        fabricApp: "git",
        purpose: "Commit, push, branch, PR, and repo management",
        role: "Source control operations layer for the fabric stack",
        criticality: "Medium",
        architecture: {
            deploymentType: "Kubernetes (fabric-git pod in fabric-sdk)",
            hostLocation: "k3s cluster",
            networkDeps: ["GitHub API"],
            storageDeps: ["None — stateless, operates via GitHub API"],
            relatedServices: ["CVE (PR creation)", "fabric-ctrl (GitHub App)", "ArgoCD (GitOps sync)"],
        },
        security: {
            authMethod: "GitHub App installation token",
            exposureSurface: "GitHub API only",
            knownRisks: ["Token expiry", "Rate limiting on high-volume operations"],
            integrations: ["fabric-ctrl (GitHub App identity)", "ArgoCD (watches for changes)"],
        },
        observability: {
            monitoring: ["GitHub API rate limit headers"],
            logging: ["Pod logs"],
            metrics: "Repo list, commit history, PR status via MCP tools",
            alerting: "None dedicated",
        },
        dependencies: {
            upstream: ["GitHub API", "fabric-ctrl (auth)"],
            downstream: ["ArgoCD (syncs from git)", "CVE (creates PRs)", "Pipelines (reads/writes repos)"],
        },
        failureModes: [
            { issue: "GitHub API rate limited", troubleshooting: "Check rate limit headers, back off, verify token is installation token (higher limits)" },
            { issue: "Auth token expired", troubleshooting: "fabric-ctrl should auto-refresh — check ctrl health" },
        ],
        recommendations: [
            "Use installation tokens (5000 req/hr) not personal tokens (5000 req/hr shared)",
            "Cache repo metadata to reduce API calls",
            "Monitor rate limit usage",
        ],
    },
    aiana: {
        name: "Aiana Memory",
        fabricApp: "aiana",
        purpose: "Semantic memory, session context, and cross-project recall",
        role: "Long-term memory layer for AI assistants across the fabric",
        criticality: "Medium",
        architecture: {
            deploymentType: "Kubernetes (fabric-aiana pod in fabric-sdk)",
            hostLocation: "k3s cluster",
            networkDeps: ["Qdrant (vector storage)", "Anthropic API (embeddings)"],
            storageDeps: ["Qdrant collection for memory vectors"],
            relatedServices: ["Chat (memory recall)", "Qdrant (vector DB)", "Ollama (local embeddings)"],
        },
        security: {
            authMethod: "Anthropic API key for embeddings",
            exposureSurface: "Internal cluster only — no external access",
            knownRisks: ["Memory poisoning (bad data in vector store)", "Embedding model drift"],
            integrations: ["Chat (context injection)", "Pipelines (automated memory writes)"],
        },
        observability: {
            monitoring: ["Pod health via k8s"],
            logging: ["Pod logs"],
            metrics: "Memory count, search quality via MCP tools",
            alerting: "None dedicated",
        },
        dependencies: {
            upstream: ["Qdrant (vector storage)", "Anthropic/Ollama (embedding generation)"],
            downstream: ["Chat (memory recall for conversations)", "Pipelines (context enrichment)"],
        },
        failureModes: [
            { issue: "Qdrant unreachable", troubleshooting: "Check Qdrant pod/service health, verify network connectivity" },
            { issue: "Embedding API failure", troubleshooting: "Check Anthropic API key or Ollama endpoint, verify model availability" },
        ],
        recommendations: [
            "Migrate to local Qdrant to reduce latency",
            "Use Ollama nomic-embed-text for local embeddings",
            "Periodic memory cleanup — remove stale/low-quality entries",
        ],
    },
    chat: {
        name: "Cortex Chat",
        fabricApp: "chat",
        purpose: "AI conversation sessions, semantic search, and context threading",
        role: "Primary user interface for the fabric intelligence layer",
        criticality: "High",
        architecture: {
            deploymentType: "Kubernetes (fabric-chat pod in fabric-sdk)",
            hostLocation: "k3s cluster, exposed via Traefik ingress",
            networkDeps: ["Ollama (LLM inference)", "Qdrant (vector storage)", "All fabric apps (MCP tools)", "Redis (caching)"],
            storageDeps: ["Qdrant (sessions + messages)", "Redis (report cache)"],
            relatedServices: ["All fabric apps (via MoE keyword routing)", "Ollama (completions)", "Qdrant (persistence)", "Gateway (tool discovery)"],
        },
        security: {
            authMethod: "No auth currently — internal access via ingress",
            exposureSurface: "Web UI on port 8300, exposed via Traefik ingress",
            knownRisks: ["No authentication on chat UI", "Prompt injection via user messages"],
            integrations: ["Tailscale (secure access)", "Cloudflare (DNS)"],
        },
        observability: {
            monitoring: ["Health endpoint /health", "Prometheus via kube-prometheus-stack"],
            logging: ["Pod logs", "Console output"],
            metrics: "Session count, message count, token usage via chat_status tool",
            alerting: "None dedicated",
        },
        dependencies: {
            upstream: ["Ollama (LLM)", "Qdrant (state)", "Redis (cache)", "All fabric apps (data)"],
            downstream: ["User (via web UI)", "Aiana (memory storage)"],
        },
        failureModes: [
            { issue: "Ollama cold start (slow first response)", troubleshooting: "Model loads on first request — keep_alive: 30m prevents unloading. Send a warm-up request after deploy." },
            { issue: "Qdrant connection failure", troubleshooting: "Check Qdrant health endpoint, verify QDRANT_URL env var" },
            { issue: "Fabric app unreachable", troubleshooting: "Pre-fetch returns null gracefully — check target fabric app pod status" },
        ],
        recommendations: [
            "Add authentication to the chat UI",
            "Implement Redis caching for MCP responses",
            "Set up health alerting for chat pod",
            "Monitor Ollama inference latency",
            "Warm up Ollama model on pod startup",
        ],
    },
};
// ── Aliases ──────────────────────────────────────────────────────────────────
// Sub-services and common names that resolve to their parent fabric app
const ALIASES = {
    argocd: "k8s", argo: "k8s", longhorn: "k8s", traefik: "k8s",
    rancher: "k8s", helm: "k8s", kubectl: "k8s",
    pve: "proxmox", qemu: "proxmox", lxc: "proxmox", ceph: "proxmox",
    wifi: "unifi", wireless: "unifi", ubiquiti: "unifi", ap: "unifi",
    dns: "cloudflare", zone: "cloudflare",
    vpn: "tailscale", tailnet: "tailscale", wireguard: "tailscale",
    vulnerability: "cve", vuln: "cve",
    memory: "aiana", recall: "aiana",
    cortex: "chat", conversation: "chat",
};
// ── Dependency Maps (for "map" mode) ─────────────────────────────────────────
const DEPENDENCY_TREES = {
    proxmox: `Proxmox VE (pve01)
├── k3s-master01 (VM, 8Gi)
├── k3s-master02 (VM, 8Gi)
├── k3s-worker01 (VM, 10Gi)
├── k3s-worker02 (VM, 10Gi)
├── k3s-worker03 (VM, 10Gi)
└── ZFS Storage Pool
    └── VM disk images`,
    k8s: `Kubernetes (k3s) — 5 nodes, 81 pods
├── fabric-sdk namespace
│   ├── fabric-gateway (AS65000)
│   ├── fabric-unifi (AS65001)
│   ├── fabric-proxmox (AS65002)
│   ├── fabric-k8s (AS65003)
│   ├── fabric-cloudflare (AS65005)
│   ├── fabric-tailscale (AS65006)
│   ├── fabric-sandfly (AS65007)
│   ├── fabric-cve (AS65008)
│   ├── fabric-git (AS65009)
│   ├── fabric-aiana (AS65010)
│   ├── fabric-chat (AS65011)
│   ├── ollama (qwen2.5-coder:7b)
│   ├── qdrant (vector DB)
│   └── redis-master (cache)
├── argocd namespace
│   └── ArgoCD (GitOps controller)
├── monitoring namespace
│   ├── Prometheus
│   └── Grafana
├── Longhorn (distributed storage)
│   └── PVCs for ollama, qdrant, redis
└── Traefik (ingress controller)
    └── IngressRoutes for chat, dashboard, grafana`,
    unifi: `UniFi Network
├── UDM Pro (gateway + controller)
│   ├── U7 Pro (AP)
│   ├── U6+ (AP)
│   ├── AC Pro (AP) ← OFFLINE
│   ├── USW Enterprise 24 PoE (switch)
│   └── USP PDU Pro (power)
└── Cable Internet (UCI)
    └── ISP uplink`,
    cloudflare: `Cloudflare
├── ryandahlberg.com (zone)
│   ├── DNS records → Traefik ingress
│   ├── CDN / cache
│   └── DDoS protection
└── KV namespaces
    └── Edge storage`,
    tailscale: `Tailscale Mesh
├── k3s subnet router (pod)
│   └── Routes: 10.42.0.0/16, 10.43.0.0/16
├── macOS devices (2)
├── Linux devices (2)
└── iOS device (1)`,
    sandfly: `Sandfly Security
├── sandfly-server (k3s pod)
│   └── PostgreSQL (state DB)
├── sandfly-node (DaemonSet)
│   └── SSH scanner → all k3s nodes
└── Scan targets
    ├── k3s-master01
    ├── k3s-master02
    ├── k3s-worker01
    ├── k3s-worker02
    └── k3s-worker03`,
    cve: `CVE Pipeline
├── fabric-cve (k3s pod)
│   ├── Scan layer → NVD/GitHub Advisories
│   ├── Enrich layer → CVSS scoring
│   ├── Triage layer → priority queue
│   └── Action layer → PR creation
├── fabric-state (queue persistence)
└── GitHub Actions
    ├── cve-scan.yml (scheduled)
    └── cve-triage.yml (on-demand)`,
    git: `Git Operations
├── fabric-git (k3s pod)
│   ├── GitHub API client
│   └── fabric-ctrl (auth provider)
└── git-fabric org (21 repos)
    ├── 10 fabric apps
    ├── Platform repos (gateway, sdk, ctrl)
    └── Ops repos (gitops, forge, pipelines)`,
    aiana: `Aiana Memory
├── fabric-aiana (k3s pod)
│   ├── Qdrant (vector storage)
│   └── Ollama nomic-embed-text (embeddings)
└── Consumers
    ├── Chat (memory recall)
    └── Pipelines (context enrichment)`,
    chat: `Cortex Chat
├── fabric-chat (k3s pod)
│   ├── Ollama (LLM inference)
│   ├── Qdrant (session + message storage)
│   ├── Redis (report cache)
│   └── MoE Router → fabric apps
│       ├── fabric-unifi
│       ├── fabric-proxmox
│       ├── fabric-k8s
│       ├── fabric-cloudflare
│       ├── fabric-tailscale
│       ├── fabric-sandfly
│       ├── fabric-cve
│       └── fabric-git
├── Web UI (Cortex)
└── MCP endpoint (/mcp)`,
};
// ── Inspect Mode: extra tools to call per app ────────────────────────────────
export const INSPECT_TOOLS = {
    unifi: [
        { tool: "unifi_network_status", key: "status" },
        { tool: "unifi_list_devices", key: "devices" },
        { tool: "unifi_list_sites", key: "sites" },
        { tool: "unifi_list_hosts", key: "hosts" },
    ],
    proxmox: [
        { tool: "pve_cluster_status", key: "cluster" },
        { tool: "pve_list_nodes", key: "nodes" },
        { tool: "pve_list_vms", args: { node: "pve01" }, key: "vms" },
        { tool: "pve_list_containers", args: { node: "pve01" }, key: "containers" },
        { tool: "pve_list_storage", key: "storage" },
        { tool: "pve_list_tasks", key: "tasks" },
    ],
    k8s: [
        { tool: "k8s_cluster_info", key: "cluster" },
        { tool: "k8s_list_nodes", key: "nodes" },
        { tool: "k8s_list_pods", key: "pods" },
        { tool: "k8s_list_deployments", key: "deployments" },
        { tool: "k8s_pod_problems", key: "problems" },
        { tool: "k8s_list_events", key: "events" },
        { tool: "k8s_list_argocd_apps", key: "argocd" },
        { tool: "k8s_list_longhorn_volumes", key: "longhorn" },
        { tool: "k8s_list_pvcs", key: "pvcs" },
        { tool: "k8s_list_ingress_routes", key: "ingress" },
    ],
    cloudflare: [
        { tool: "cf_list_zones", key: "zones" },
        { tool: "cf_list_dns_records", key: "records" },
    ],
    tailscale: [
        { tool: "ts_health", key: "health" },
        { tool: "ts_list_devices", key: "devices" },
        { tool: "ts_get_dns", key: "dns" },
    ],
    sandfly: [
        { tool: "sandfly_get_alerts", key: "alerts" },
        { tool: "sandfly_list_hosts", key: "hosts" },
        { tool: "sandfly_get_results", key: "results" },
    ],
    cve: [
        { tool: "cve_queue_stats", key: "stats" },
    ],
    git: [
        { tool: "git_repo_list", key: "repos" },
        { tool: "git_pr_list", key: "prs" },
    ],
};
// ── Public API ───────────────────────────────────────────────────────────────
/** Parse user message for service intelligence triggers */
export function parseServiceQuery(message) {
    const lower = message.toLowerCase().trim();
    // "map <name>" mode
    const mapMatch = lower.match(/^map\s+(.+)/);
    if (mapMatch) {
        const app = resolveAppName(mapMatch[1].trim());
        if (app)
            return { app, mode: "map" };
    }
    // "inspect <name>" mode
    const inspectMatch = lower.match(/^inspect\s+(.+)/);
    if (inspectMatch) {
        const app = resolveAppName(inspectMatch[1].trim());
        if (app)
            return { app, mode: "inspect" };
    }
    // "service <name>" mode
    const serviceMatch = lower.match(/^service\s+(.+)/);
    if (serviceMatch) {
        const app = resolveAppName(serviceMatch[1].trim());
        if (app)
            return { app, mode: "overview" };
    }
    return null;
}
/** Resolve a service name (including aliases) to a fabric app key */
export function resolveAppName(name) {
    const lower = name.toLowerCase().trim();
    if (PROFILES[lower])
        return lower;
    if (ALIASES[lower])
        return ALIASES[lower];
    // Fuzzy: check if any profile name starts with the input
    for (const key of Object.keys(PROFILES)) {
        if (key.startsWith(lower))
            return key;
    }
    return null;
}
/** Get the service profile for an app */
export function getProfile(app) {
    return PROFILES[app] ?? null;
}
/** Format the dependency tree for "map" mode */
export function formatMap(app) {
    const profile = PROFILES[app];
    if (!profile)
        return `Unknown service: ${app}`;
    const tree = DEPENDENCY_TREES[app];
    if (!tree)
        return `No dependency map available for ${profile.name}`;
    const lines = [
        `# DEPENDENCY MAP — ${profile.name}`,
        "",
        "```",
        tree,
        "```",
        "",
        "## Upstream Dependencies",
        ...profile.dependencies.upstream.map((d) => `- ${d}`),
        "",
        "## Downstream Dependencies",
        ...profile.dependencies.downstream.map((d) => `- ${d}`),
    ];
    return lines.join("\n");
}
/** Format a full service overview briefing (static + live data) */
export function formatBriefing(app, liveData, toolList) {
    const profile = PROFILES[app];
    if (!profile)
        return `Unknown service: ${app}`;
    const arch = profile.architecture;
    const sec = profile.security;
    const obs = profile.observability;
    const lines = [
        `# SERVICE OVERVIEW`,
        "",
        `**Name:** ${profile.name}`,
        `**Purpose:** ${profile.purpose}`,
        `**Role:** ${profile.role}`,
        `**Criticality:** ${profile.criticality}`,
        "",
        "---",
        "",
        "# ARCHITECTURE",
        "",
        `**Deployment:** ${arch.deploymentType}`,
        `**Location:** ${arch.hostLocation}`,
        `**Network:** ${arch.networkDeps.join(", ")}`,
        `**Storage:** ${arch.storageDeps.join(", ")}`,
        "",
        "**Related Services:**",
        ...arch.relatedServices.map((s) => `- ${s}`),
        "",
        "---",
        "",
        "# CURRENT STATUS",
        "",
    ];
    // Live data section — from MCP telemetry
    if (liveData) {
        lines.push(liveData);
    }
    else {
        lines.push("Telemetry not available from MCP source.");
    }
    lines.push("", "---", "", "# SECURITY POSTURE", "", `**Authentication:** ${sec.authMethod}`, `**Exposure:** ${sec.exposureSurface}`, "", "**Known Risks:**", ...sec.knownRisks.map((r) => `- ${r}`), "", "**Integrations:**", ...sec.integrations.map((i) => `- ${i}`), "", "---", "", "# OBSERVABILITY", "", `**Monitoring:** ${obs.monitoring.join(", ")}`, `**Logging:** ${obs.logging.join(", ")}`, `**Metrics:** ${obs.metrics}`, `**Alerting:** ${obs.alerting}`, "", "---", "", "# DEPENDENCIES", "", "**Upstream:**", ...profile.dependencies.upstream.map((d) => `- ${d}`), "", "**Downstream:**", ...profile.dependencies.downstream.map((d) => `- ${d}`));
    // Operational commands — from MCP tool list
    if (toolList && toolList.length > 0) {
        lines.push("", "---", "", "# OPERATIONAL COMMANDS", "", `Available MCP tools (${toolList.length}):`, ...toolList.map((t) => `- \`${t}\``));
    }
    lines.push("", "---", "", "# COMMON FAILURE MODES", "", ...profile.failureModes.flatMap((f) => [
        `**${f.issue}**`,
        `→ ${f.troubleshooting}`,
        "",
    ]), "---", "", "# RECOMMENDATIONS", "", ...profile.recommendations.map((r, i) => `${i + 1}. ${r}`));
    return lines.join("\n");
}
//# sourceMappingURL=service-intel.js.map