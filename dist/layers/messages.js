/**
 * Messages layer
 *
 * Message send/receive: complete a turn, list messages, inject context.
 * Handles full Anthropic API round-trip with session history reconstruction.
 * When a fabric gateway is configured, uses Claude tool_use to query live
 * infrastructure data (k8s, unifi, proxmox, sandfly, cve, cloudflare, tailscale).
 *
 * Inputs:  ChatAdapter + message params
 * Outputs: ChatMessage objects / send results
 */
import Anthropic from "@anthropic-ai/sdk";
import { selectRelevantTools } from "../adapters/gateway.js";
import { createOllamaConfig, ollamaCompleteStream } from "../adapters/ollama.js";
// ── MoE keyword router (inline, mirrors gateway moe.js) ─────────────────────
// Used to detect which fabric app a user message is about, so we can pre-fetch
// live data before sending to Ollama (which can't do tool_use).
const MOE_ROUTES = [
    { app: "unifi", service: "fabric-unifi", port: 8200, priority: 100, keywords: ["unifi", "wifi", "wireless", "ssid", "access point", "ubiquiti", "vlan", "ap "] },
    { app: "proxmox", service: "fabric-proxmox", port: 8200, priority: 100, keywords: ["proxmox", "pve", "vm", "virtual machine", "lxc", "hypervisor", "qemu"] },
    { app: "k8s", service: "fabric-k8s", port: 8200, priority: 100, keywords: ["kubernetes", "k8s", "k3s", "pod", "deployment", "namespace", "kubectl", "ingress", "helm", "statefulset", "argocd", "longhorn"] },
    { app: "cloudflare", service: "fabric-cloudflare", port: 8200, priority: 90, keywords: ["cloudflare", "dns record", "zone", "cname", "cache purge", "worker", "tunnel"] },
    { app: "tailscale", service: "fabric-tailscale", port: 8200, priority: 90, keywords: ["tailscale", "vpn", "tailnet", "exit node", "subnet router", "magic dns"] },
    { app: "cve", service: "fabric-cve", port: 8200, priority: 90, keywords: ["cve", "vulnerability", "vuln", "patch", "security scan", "advisory", "exploit"] },
    { app: "sandfly", service: "fabric-sandfly", port: 8200, priority: 90, keywords: ["sandfly", "intrusion", "threat", "malware", "rootkit", "ioc"] },
    { app: "git", service: "fabric-git", port: 8200, priority: 80, keywords: ["git repo", "commit", "branch", "pull request", "pr ", "merge", "release"] },
];
/** Canonical name aliases — maps user-facing names to internal app keys */
const APP_ALIASES = {
    // Direct matches
    unifi: "unifi",
    proxmox: "proxmox",
    kubernetes: "k8s",
    k8s: "k8s",
    k3s: "k8s",
    cloudflare: "cloudflare",
    tailscale: "tailscale",
    cve: "cve",
    sandfly: "sandfly",
    git: "git",
    // Sub-services that map to parent fabric apps
    argocd: "k8s",
    argo: "k8s",
    longhorn: "k8s",
    traefik: "k8s",
    rancher: "k8s",
    ceph: "proxmox",
    pve: "proxmox",
    // Network sub-services
    wifi: "unifi",
    wireless: "unifi",
    dns: "cloudflare",
    vpn: "tailscale",
    tailnet: "tailscale",
};
function parseServiceQuery(message) {
    const trimmed = message.trim().toLowerCase();
    // Match: "inspect <name>", "service <name>", "map <name>", or bare "<name>"
    let mode = "overview";
    let serviceName = trimmed;
    const inspectMatch = trimmed.match(/^inspect\s+(.+)$/);
    const serviceMatch = trimmed.match(/^service\s+(.+)$/);
    const mapMatch = trimmed.match(/^map\s+(.+)$/);
    if (inspectMatch) {
        mode = "inspect";
        serviceName = inspectMatch[1].trim();
    }
    else if (serviceMatch) {
        mode = "overview";
        serviceName = serviceMatch[1].trim();
    }
    else if (mapMatch) {
        mode = "map";
        serviceName = mapMatch[1].trim();
    }
    // Look up the canonical app name
    const app = APP_ALIASES[serviceName];
    if (!app)
        return null;
    // Find the matching route
    const route = MOE_ROUTES.find((r) => r.app === app);
    if (!route)
        return null;
    return { mode, app, route, originalMessage: message };
}
function detectFabricApp(message) {
    const lower = message.toLowerCase();
    let best = null;
    for (const route of MOE_ROUTES) {
        let score = 0;
        for (const kw of route.keywords) {
            if (lower.includes(kw))
                score += route.priority;
        }
        if (score > 0 && (!best || score > best.score)) {
            best = { route, score };
        }
    }
    return best ? best.route : null;
}
/** Does the message need LLM reasoning, or is a pre-formatted report sufficient? */
function needsLlmReasoning(message) {
    const lower = message.toLowerCase().trim();
    // Questions need reasoning
    if (/\?$/.test(lower))
        return true;
    if (/^(how|what|why|when|where|which|who|can|could|should|is|are|do|does|will|would|explain|compare|tell me|help|describe)[\s,]/.test(lower))
        return true;
    // Multi-word analysis requests
    if (/\b(wrong|issue|problem|fix|diagnose|troubleshoot|analyze|recommend|suggest)\b/.test(lower))
        return true;
    // Short keyword-style messages → report is enough
    return false;
}
/** Default summary tools for each fabric app (used for bare app name queries) */
/** Multiple tools are fetched in parallel and merged for richer reports */
const SUMMARY_TOOLS = {
    unifi: [{ tool: "unifi_network_status", key: "status" }],
    proxmox: [
        { tool: "pve_cluster_status", key: "cluster" },
        { tool: "pve_list_vms", args: { node: "pve01" }, key: "vms" },
        { tool: "pve_list_storage", key: "storage" },
    ],
    k8s: [
        { tool: "k8s_cluster_info", key: "cluster" },
        { tool: "k8s_list_nodes", key: "nodes" },
    ],
    cloudflare: [{ tool: "cf_list_zones", key: "zones" }],
    tailscale: [{ tool: "ts_health", key: "health" }],
    cve: [{ tool: "cve_queue_stats", key: "stats" }],
    sandfly: [{ tool: "sandfly_get_alerts", key: "alerts" }],
    git: [{ tool: "git_repo_list", key: "repos" }],
};
/** Deep inspection tools — fetches ALL available telemetry for a service */
const INSPECT_TOOLS = {
    unifi: [
        { tool: "unifi_network_status", key: "status" },
        { tool: "unifi_list_devices", key: "devices" },
        { tool: "unifi_list_sites", key: "sites" },
    ],
    proxmox: [
        { tool: "pve_cluster_status", key: "cluster" },
        { tool: "pve_list_vms", args: { node: "pve01" }, key: "vms" },
        { tool: "pve_list_containers", args: { node: "pve01" }, key: "containers" },
        { tool: "pve_list_storage", key: "storage" },
        { tool: "pve_list_tasks", key: "tasks" },
    ],
    k8s: [
        { tool: "k8s_cluster_info", key: "cluster" },
        { tool: "k8s_list_nodes", key: "nodes" },
        { tool: "k8s_list_pods", args: {}, key: "pods" },
        { tool: "k8s_list_deployments", key: "deployments" },
        { tool: "k8s_list_events", key: "events" },
        { tool: "k8s_list_pvcs", key: "pvcs" },
        { tool: "k8s_list_argocd_apps", key: "argocd" },
        { tool: "k8s_list_longhorn_volumes", key: "longhorn" },
        { tool: "k8s_list_ingress_routes", key: "ingress" },
        { tool: "k8s_pod_problems", key: "problems" },
    ],
    cloudflare: [
        { tool: "cf_list_zones", key: "zones" },
        { tool: "cf_list_dns_records", key: "records" },
        { tool: "cf_zone_analytics", key: "analytics" },
    ],
    tailscale: [
        { tool: "ts_health", key: "health" },
        { tool: "ts_list_devices", key: "devices" },
        { tool: "ts_get_dns", key: "dns" },
        { tool: "ts_get_acl", key: "acl" },
    ],
    cve: [
        { tool: "cve_queue_stats", key: "stats" },
    ],
    sandfly: [
        { tool: "sandfly_get_alerts", key: "alerts" },
        { tool: "sandfly_list_hosts", key: "hosts" },
        { tool: "sandfly_get_results", key: "results" },
    ],
    git: [
        { tool: "git_repo_list", key: "repos" },
        { tool: "git_pr_list", key: "prs" },
        { tool: "git_commit_list", key: "commits" },
    ],
};
/** Specific query patterns → tool mappings for targeted questions */
const SPECIFIC_QUERIES = [
    // K8s
    { pattern: /how many pods|list pods|pod count|pods running|pods status/i, app: "k8s", tool: "k8s_list_pods", args: {} },
    { pattern: /pod (problem|fail|crash|error|not ready)/i, app: "k8s", tool: "k8s_pod_problems" },
    { pattern: /deployment|deployments/i, app: "k8s", tool: "k8s_list_deployments" },
    { pattern: /node status|nodes|cluster nodes/i, app: "k8s", tool: "k8s_list_nodes" },
    { pattern: /event|warning|cluster event/i, app: "k8s", tool: "k8s_list_events" },
    { pattern: /argocd|argo app|sync status/i, app: "k8s", tool: "k8s_list_argocd_apps" },
    { pattern: /pvc|volume|storage claim/i, app: "k8s", tool: "k8s_list_pvcs" },
    { pattern: /longhorn/i, app: "k8s", tool: "k8s_list_longhorn_volumes" },
    { pattern: /ingress|route|traefik/i, app: "k8s", tool: "k8s_list_ingress_routes" },
    // UniFi
    { pattern: /device|ap |access point|switch/i, app: "unifi", tool: "unifi_list_devices" },
    { pattern: /client|connected|bandwidth/i, app: "unifi", tool: "unifi_network_status" },
    { pattern: /site/i, app: "unifi", tool: "unifi_list_sites" },
    // Proxmox
    { pattern: /vm|virtual machine/i, app: "proxmox", tool: "pve_list_vms", args: { node: "pve01" } },
    { pattern: /container|lxc/i, app: "proxmox", tool: "pve_list_containers", args: { node: "pve01" } },
    { pattern: /storage|disk/i, app: "proxmox", tool: "pve_list_storage" },
    { pattern: /task|job/i, app: "proxmox", tool: "pve_list_tasks" },
    // Tailscale
    { pattern: /device|machine|node/i, app: "tailscale", tool: "ts_list_devices" },
    { pattern: /acl|access control|policy/i, app: "tailscale", tool: "ts_get_acl" },
    { pattern: /dns|nameserver/i, app: "tailscale", tool: "ts_get_dns" },
    // Cloudflare
    { pattern: /dns record|record/i, app: "cloudflare", tool: "cf_list_dns_records" },
    { pattern: /analytic|traffic|bandwidth/i, app: "cloudflare", tool: "cf_zone_analytics" },
    // Git
    { pattern: /pull request|pr /i, app: "git", tool: "git_pr_list" },
    { pattern: /commit/i, app: "git", tool: "git_commit_list" },
    // Sandfly
    { pattern: /alert|threat|finding/i, app: "sandfly", tool: "sandfly_get_alerts" },
    { pattern: /host|server|machine/i, app: "sandfly", tool: "sandfly_list_hosts" },
    { pattern: /scan|result/i, app: "sandfly", tool: "sandfly_get_results" },
];
/** Determine which tool(s) to call based on the user message */
function selectTools(app, message) {
    // Check for specific query patterns first — single tool
    for (const q of SPECIFIC_QUERIES) {
        if (q.app === app && q.pattern.test(message)) {
            return [{ tool: q.tool, args: q.args ?? {}, key: "result" }];
        }
    }
    // Fall back to default summary tools (may be multiple)
    return SUMMARY_TOOLS[app] ?? [{ tool: `${app}_health`, args: {}, key: "result" }];
}
function formatUnifi(data) {
    // Handle both direct result and keyed {status: ...} wrapper
    const inner = (data.status ?? data);
    const summary = inner.summary;
    const devices = inner.devices;
    if (!summary || !devices)
        return JSON.stringify(data, null, 2);
    const devSummary = summary.devices;
    const lines = [
        `## UniFi Network Report`,
        ``,
        `**${devSummary?.total ?? "?"} devices** — ${devSummary?.online ?? "?"} online, ${devSummary?.offline ?? "?"} offline`,
        `**${summary.hosts ?? "?"} host(s)**, **${summary.sites ?? "?"} site(s)**`,
        ``,
        `### Devices`,
    ];
    for (const d of devices) {
        const status = d.status === "online" ? "✅" : "🔴";
        const fw = d.firmwareStatus === "upToDate" ? "" : ` ⚠️ ${d.firmwareStatus}`;
        lines.push(`${status} **${d.name}** (${d.model}) — ${d.ip}${d.version ? ` v${d.version}` : ""}${fw}`);
    }
    const offline = devices.filter((d) => d.status !== "online");
    if (offline.length > 0) {
        lines.push("", "### Issues");
        for (const d of offline)
            lines.push(`- **${d.name}** (${d.model}) is offline — MAC: ${d.mac}`);
    }
    return lines.join("\n");
}
function formatProxmox(data) {
    const cluster = data.cluster;
    const vms = data.vms;
    const storage = data.storage;
    const lines = ["## Proxmox Cluster Report", ""];
    // Nodes from cluster status
    if (Array.isArray(cluster)) {
        const nodes = cluster.filter((r) => r.type === "node");
        const qemuFromCluster = cluster.filter((r) => r.type === "qemu");
        const lxcFromCluster = cluster.filter((r) => r.type === "lxc");
        lines.push("### Nodes");
        for (const n of nodes) {
            const status = n.status === "online" ? "✅" : "🔴";
            const cpu = n.cpu != null ? ` — CPU: ${(Number(n.cpu) * 100).toFixed(0)}%` : "";
            const mem = n.maxmem ? ` — RAM: ${fmtBytes(Number(n.mem))}/${fmtBytes(Number(n.maxmem))}` : "";
            lines.push(`${status} **${n.node}**${cpu}${mem}`);
        }
        if (nodes.length === 0)
            lines.push("- No node data available");
        // VMs from cluster/resources (has CPU/mem)
        const allVms = qemuFromCluster.length > 0 ? qemuFromCluster : (Array.isArray(vms) ? vms : []);
        if (allVms.length > 0) {
            lines.push("", "### Virtual Machines");
            for (const vm of allVms) {
                const status = vm.status === "running" ? "✅" : vm.status === "stopped" ? "⏹️" : "⚠️";
                const cpu = vm.cpu != null ? ` CPU: ${(Number(vm.cpu) * 100).toFixed(0)}%` : "";
                const mem = vm.maxmem ? ` RAM: ${fmtBytes(Number(vm.mem))}/${fmtBytes(Number(vm.maxmem))}` : "";
                const name = vm.name ?? `VM ${vm.vmid}`;
                lines.push(`${status} **${name}** (${vm.status})${cpu}${mem}`);
            }
        }
        if (lxcFromCluster.length > 0) {
            lines.push("", "### Containers (LXC)");
            for (const ct of lxcFromCluster) {
                const status = ct.status === "running" ? "✅" : "⏹️";
                const name = ct.name ?? `CT ${ct.vmid}`;
                lines.push(`${status} **${name}** (${ct.status})`);
            }
        }
    }
    else {
        lines.push("No cluster data available.");
    }
    if (Array.isArray(storage) && storage.length > 0) {
        lines.push("", "### Storage");
        for (const s of storage) {
            const used = s.disk != null && s.maxdisk ? `${fmtBytes(Number(s.disk))}/${fmtBytes(Number(s.maxdisk))}` : "?";
            const pct = s.disk != null && s.maxdisk ? ` (${((Number(s.disk) / Number(s.maxdisk)) * 100).toFixed(0)}%)` : "";
            lines.push(`- **${s.storage ?? s.name}** on ${s.node ?? "?"}: ${used}${pct}`);
        }
    }
    return lines.join("\n");
}
function fmtBytes(bytes) {
    if (bytes >= 1073741824)
        return `${(bytes / 1073741824).toFixed(1)}Gi`;
    if (bytes >= 1048576)
        return `${(bytes / 1048576).toFixed(0)}Mi`;
    return `${(bytes / 1024).toFixed(0)}Ki`;
}
function formatK8s(data) {
    const cluster = data.cluster;
    // list_nodes returns a flat array, not {nodes: [...]}
    const rawNodes = data.nodes;
    const nodes = (Array.isArray(rawNodes) ? rawNodes : rawNodes?.nodes ?? []);
    const lines = [
        "## Kubernetes Cluster Report",
        "",
        `- **Server version:** ${cluster?.serverVersion ?? "?"} (${cluster?.platform ?? "?"})`,
        `- **Nodes:** ${cluster?.nodeCount ?? nodes.length}`,
        `- **Namespaces:** ${cluster?.namespaceCount ?? "?"}`,
        `- **Pods:** ${cluster?.podCount ?? "?"}`,
    ];
    if (nodes.length > 0) {
        lines.push("", "### Nodes");
        for (const n of nodes) {
            const status = n.status === "Ready" ? "✅" : "🔴";
            const roles = String(n.roles ?? "worker");
            const age = n.age ? ` — age: ${n.age}` : "";
            const os = n.os ? ` — ${n.os}` : "";
            lines.push(`${status} **${n.name}** (${roles}) ${n.version ?? ""}${age}${os}`);
        }
    }
    return lines.join("\n");
}
function formatTailscale(data) {
    const health = (data.health ?? data);
    const summary = health.summary;
    const devicesByOs = health.devices_by_os;
    const exitNodes = health.exit_nodes;
    const lines = [
        "## Tailscale Network Report",
        "",
        `- **Status:** ${health.healthy ? "✅ Healthy" : "⚠️ Degraded"}`,
        `- **Total devices:** ${summary?.total_devices ?? "?"}`,
        `- **Authorized:** ${summary?.authorized ?? "?"}`,
        `- **Exit nodes:** ${summary?.exit_nodes ?? exitNodes?.length ?? 0}`,
    ];
    if (devicesByOs && Object.keys(devicesByOs).length > 0) {
        lines.push("", "### Devices by OS");
        for (const [os, count] of Object.entries(devicesByOs)) {
            lines.push(`- **${os}:** ${count}`);
        }
    }
    return lines.join("\n");
}
function formatCloudflare(data) {
    const zones = (data.zones ?? data);
    if (!Array.isArray(zones))
        return JSON.stringify(data, null, 2);
    const lines = [
        "## Cloudflare Report",
        "",
        `**${zones.length} zone(s)**`,
        "",
    ];
    for (const z of zones) {
        const status = z.status === "active" ? "✅" : "⚠️";
        const plan = z.plan?.name ?? "?";
        lines.push(`${status} **${z.name}** — ${z.status}, plan: ${plan}`);
    }
    return lines.join("\n");
}
function formatGeneric(app, data) {
    const title = app.charAt(0).toUpperCase() + app.slice(1);
    if (Array.isArray(data)) {
        const lines = [`## ${title} Report`, "", `**${data.length} items**`, ""];
        for (const item of data.slice(0, 20)) {
            const i = item;
            const name = i.name ?? i.full_name ?? i.id ?? "?";
            const desc = i.description ?? i.status ?? "";
            lines.push(`- **${name}**${desc ? ` — ${desc}` : ""}`);
        }
        if (data.length > 20)
            lines.push(`- ... and ${data.length - 20} more`);
        return lines.join("\n");
    }
    return `## ${title} Report\n\n${JSON.stringify(data, null, 2)}`;
}
const FORMATTERS = {
    unifi: formatUnifi,
    proxmox: formatProxmox,
    k8s: formatK8s,
    tailscale: formatTailscale,
    cloudflare: formatCloudflare,
};
const SERVICE_META = {
    unifi: {
        name: "UniFi Network",
        purpose: "Centralized network management — switches, APs, security gateway",
        role: "Core network fabric — manages all VLANs, wireless, and L2/L3 switching",
        criticality: "Critical",
        deploymentType: "Hardware appliance (UDM Pro) + managed switches + APs",
        hostNode: "UDM Pro (standalone)",
        networkDeps: "Management VLAN, upstream ISP",
        storageDeps: "UDM Pro internal storage",
        relatedServices: ["Tailscale", "Cloudflare", "Proxmox", "Kubernetes"],
        authMethod: "Local admin + UniFi Cloud SSO",
        exposureSurface: "Management UI (HTTPS), SSH to devices",
        knownRisks: ["Firmware update failures", "AP adoption issues", "VLAN misconfiguration"],
        securityIntegrations: ["Tailscale (VPN bypass)", "Cloudflare (DNS)"],
        monitoring: "UniFi built-in dashboard",
        logging: "UniFi event log, syslog",
        operationalCommands: [
            "unifi_network_status — full network overview",
            "unifi_list_devices — all managed devices",
            "unifi_list_sites — site list",
        ],
        commonFailures: [
            "AP offline → check PoE port, power cycle switch port",
            "Client can't connect → check VLAN assignment, RADIUS",
            "Firmware stuck → SSH to device, manual upgrade",
        ],
        recommendations: [
            "Enable auto-backup on UDM Pro",
            "Set firmware auto-update to stable channel only",
            "Monitor AP channel utilization for DFS interference",
            "Add SNMP polling for switch port utilization",
        ],
        upstreamDeps: ["ISP", "Power/PoE"],
        downstreamDeps: ["All networked services", "Tailscale", "DNS"],
    },
    proxmox: {
        name: "Proxmox VE",
        purpose: "Type-1 hypervisor — VM and LXC container management",
        role: "Compute foundation — hosts all VMs and containers for the homelab",
        criticality: "Critical",
        deploymentType: "Bare-metal cluster",
        hostNode: "pve01 (physical server)",
        networkDeps: "Management VLAN, storage network",
        storageDeps: "Local ZFS, NFS, Ceph (if configured)",
        relatedServices: ["Kubernetes (k3s VMs)", "UniFi", "Tailscale"],
        authMethod: "PAM / PVE local auth",
        exposureSurface: "Web UI (8006), SSH, SPICE console",
        knownRisks: ["Storage pool full", "HA failover misconfiguration", "Kernel panic on host"],
        securityIntegrations: ["Tailscale (remote access)", "Sandfly (host intrusion)"],
        monitoring: "Proxmox built-in metrics, node exporter",
        logging: "journald, pveproxy logs",
        operationalCommands: [
            "pve_cluster_status — cluster health + node status",
            "pve_list_vms — all VMs with CPU/RAM metrics",
            "pve_list_containers — LXC containers",
            "pve_list_storage — storage pools + usage",
            "pve_list_tasks — recent task log",
        ],
        commonFailures: [
            "VM won't start → check storage availability, disk locks",
            "Cluster quorum lost → check corosync, network between nodes",
            "Storage full → check ZFS pool, thin provisioning",
            "High CPU → identify runaway VM, check iowait",
        ],
        recommendations: [
            "Schedule regular vzdump backups to offsite",
            "Set up email alerts for storage thresholds (80%+)",
            "Keep kernel and packages updated monthly",
            "Monitor disk SMART data for early failure detection",
            "Enable HA for critical VMs",
        ],
        upstreamDeps: ["Power", "Network (UniFi)", "Storage (local/NFS)"],
        downstreamDeps: ["Kubernetes nodes", "All hosted VMs", "LXC containers"],
    },
    k8s: {
        name: "Kubernetes (k3s)",
        purpose: "Container orchestration — workload scheduling and service mesh",
        role: "Application platform — runs all containerized workloads via GitOps",
        criticality: "Critical",
        deploymentType: "k3s cluster on Proxmox VMs",
        hostNode: "3 masters + 3 workers (Proxmox VMs)",
        networkDeps: "Pod network (Flannel/Calico), Service CIDR, Ingress (Traefik)",
        storageDeps: "Longhorn (distributed), host-path",
        relatedServices: ["Proxmox (hosts)", "ArgoCD (GitOps)", "Longhorn (storage)", "Traefik (ingress)", "Cloudflare (DNS/tunnels)"],
        authMethod: "kubeconfig, RBAC, ServiceAccounts",
        exposureSurface: "API server (6443), Traefik ingress, NodePorts",
        knownRisks: ["etcd quorum loss", "Longhorn volume degraded", "Pod eviction due to resource pressure"],
        securityIntegrations: ["Tailscale (kubectl access)", "Cloudflare Tunnel (ingress)", "Sandfly (node scanning)"],
        monitoring: "Prometheus + Grafana (if deployed)",
        logging: "Pod logs via kubectl, Loki (if deployed)",
        operationalCommands: [
            "k8s_cluster_info — cluster version, node/pod counts",
            "k8s_list_nodes — node status + resources",
            "k8s_list_pods — all pods with status",
            "k8s_pod_problems — pods in CrashLoopBackOff/Error",
            "k8s_list_deployments — deployment rollout status",
            "k8s_list_events — recent cluster events",
            "k8s_list_argocd_apps — ArgoCD sync status",
            "k8s_list_longhorn_volumes — storage volume health",
            "k8s_list_ingress_routes — Traefik ingress routes",
            "k8s_list_pvcs — persistent volume claims",
        ],
        commonFailures: [
            "Pod CrashLoopBackOff → check logs, resource limits, image pull",
            "Node NotReady → check kubelet, disk pressure, network",
            "Longhorn volume degraded → check replica count, node storage",
            "ArgoCD OutOfSync → check git repo, manual sync",
            "Ingress 503 → check backend pods, service endpoints",
        ],
        recommendations: [
            "Enable PodDisruptionBudgets for critical workloads",
            "Set resource requests/limits on all deployments",
            "Monitor Longhorn volume health and disk space",
            "Use ArgoCD auto-sync with self-heal for GitOps consistency",
            "Regular etcd snapshots (k3s does this automatically)",
        ],
        upstreamDeps: ["Proxmox (VM hosts)", "Network (UniFi)", "DNS (Cloudflare)"],
        downstreamDeps: ["All containerized apps", "fabric-* services", "Ingress routes"],
    },
    cloudflare: {
        name: "Cloudflare",
        purpose: "DNS management, CDN, tunnels, and edge security",
        role: "Edge layer — DNS resolution, TLS termination, DDoS protection",
        criticality: "High",
        deploymentType: "External SaaS + cloudflared tunnel agent",
        hostNode: "Cloudflare edge (global) + tunnel pod in k3s",
        networkDeps: "Public internet, tunnel to k3s ingress",
        storageDeps: "None (stateless edge)",
        relatedServices: ["Kubernetes (tunnel target)", "Tailscale (internal DNS)", "UniFi (network)"],
        authMethod: "API token, Cloudflare dashboard SSO",
        exposureSurface: "Public DNS records, tunnel endpoints",
        knownRisks: ["DNS propagation delays", "Tunnel disconnection", "Rate limiting"],
        securityIntegrations: ["WAF rules", "DDoS protection", "Access policies"],
        monitoring: "Cloudflare analytics dashboard",
        logging: "Cloudflare edge logs",
        operationalCommands: [
            "cf_list_zones — DNS zones and status",
            "cf_list_dns_records — all DNS records",
            "cf_zone_analytics — traffic and performance",
        ],
        commonFailures: [
            "DNS not resolving → check record TTL, propagation",
            "Tunnel offline → check cloudflared pod, network",
            "SSL error → check origin certificate, encryption mode",
        ],
        recommendations: [
            "Enable DNSSEC on all zones",
            "Use Cloudflare Tunnel instead of port forwarding",
            "Set up page rules for caching static assets",
            "Monitor tunnel health with alerts",
        ],
        upstreamDeps: ["Internet", "Domain registrar"],
        downstreamDeps: ["All public-facing services", "DNS resolution"],
    },
    tailscale: {
        name: "Tailscale",
        purpose: "Zero-config VPN mesh — secure remote access and site connectivity",
        role: "Overlay network — connects all devices across locations via WireGuard",
        criticality: "High",
        deploymentType: "Agent on each device + Tailscale coordination server (SaaS)",
        hostNode: "Agents on: Proxmox hosts, k3s nodes, workstations, mobile",
        networkDeps: "Internet (for coordination), UDP 41641 (direct/DERP relay)",
        storageDeps: "None (stateless client)",
        relatedServices: ["UniFi (subnet routes)", "Proxmox (remote access)", "Kubernetes (kubectl)"],
        authMethod: "SSO (GitHub/Google/OIDC), pre-auth keys for servers",
        exposureSurface: "Tailscale IP space (100.x.x.x), shared nodes",
        knownRisks: ["Key expiry", "Subnet route conflicts", "DERP relay latency"],
        securityIntegrations: ["ACL policies", "MFA via SSO", "Audit logs"],
        monitoring: "Tailscale admin console",
        logging: "Tailscale event logs",
        operationalCommands: [
            "ts_health — overall tailnet health",
            "ts_list_devices — all connected devices",
            "ts_get_dns — DNS configuration",
            "ts_get_acl — access control policies",
        ],
        commonFailures: [
            "Device offline → check tailscaled service, auth key expiry",
            "Subnet route unreachable → check advertising node, ACLs",
            "Slow connection → check DERP relay, direct connection status",
        ],
        recommendations: [
            "Enable auto-approve for subnet routes",
            "Set up exit nodes for remote browsing",
            "Use pre-auth keys with tags for server automation",
            "Audit ACLs quarterly",
        ],
        upstreamDeps: ["Internet", "SSO provider"],
        downstreamDeps: ["Remote access to all services", "kubectl", "SSH"],
    },
    cve: {
        name: "CVE Scanner",
        purpose: "Vulnerability tracking and advisory monitoring",
        role: "Security intelligence — tracks CVEs relevant to deployed software",
        criticality: "Medium",
        deploymentType: "Kubernetes pod (fabric-cve)",
        hostNode: "k3s cluster",
        networkDeps: "Internet (NVD/MITRE feeds), cluster network",
        storageDeps: "Qdrant (vector store for advisory search)",
        relatedServices: ["Sandfly (threat detection)", "Kubernetes (scanned workloads)"],
        authMethod: "MCP tool access via fabric gateway",
        exposureSurface: "Internal MCP endpoint only",
        knownRisks: ["Stale CVE data if feeds unavailable", "False positives"],
        securityIntegrations: ["NVD feed", "MITRE ATT&CK"],
        monitoring: "Queue stats via cve_queue_stats",
        logging: "Pod logs",
        operationalCommands: ["cve_queue_stats — vulnerability queue metrics"],
        commonFailures: [
            "Feed sync failure → check internet, NVD API limits",
            "Queue backlog → check processing pipeline",
        ],
        recommendations: [
            "Set up daily CVE feed sync",
            "Prioritize CVEs by CVSS score and deployed software",
            "Integrate with patch management workflow",
        ],
        upstreamDeps: ["Internet (NVD feeds)", "Kubernetes"],
        downstreamDeps: ["Alert pipeline", "Patch management"],
    },
    sandfly: {
        name: "Sandfly Security",
        purpose: "Agentless Linux intrusion detection and compromise assessment",
        role: "Host security — scans all Linux hosts for threats, rootkits, and anomalies",
        criticality: "High",
        deploymentType: "Server + agents (or agentless SSH scanning)",
        hostNode: "Dedicated VM or k3s pod",
        networkDeps: "SSH access to all scanned hosts",
        storageDeps: "Local database for scan results",
        relatedServices: ["Proxmox (scanned hosts)", "Kubernetes (scanned nodes)", "CVE (vulnerability correlation)"],
        authMethod: "API key, web UI authentication",
        exposureSurface: "Web UI, API endpoint",
        knownRisks: ["SSH key compromise", "Scan resource overhead", "Alert fatigue"],
        securityIntegrations: ["Tailscale (secure scan path)", "CVE scanner"],
        monitoring: "Sandfly dashboard, alert stream",
        logging: "Scan results, audit log",
        operationalCommands: [
            "sandfly_get_alerts — active security alerts",
            "sandfly_list_hosts — scanned host inventory",
            "sandfly_get_results — detailed scan results",
        ],
        commonFailures: [
            "Scan failed → check SSH connectivity, key permissions",
            "High alert volume → tune scan policies, whitelist known good",
            "Agent offline → check sandfly-node service",
        ],
        recommendations: [
            "Schedule scans during low-usage windows",
            "Review and tune alert thresholds monthly",
            "Ensure all hosts are in scan inventory",
            "Correlate Sandfly alerts with CVE data",
        ],
        upstreamDeps: ["SSH access", "Network (UniFi)"],
        downstreamDeps: ["Alert pipeline", "Incident response"],
    },
    git: {
        name: "Git (Gitea/Forgejo)",
        purpose: "Self-hosted Git repository management",
        role: "Source of truth — stores all infrastructure-as-code and application repos",
        criticality: "High",
        deploymentType: "Kubernetes pod (fabric-git)",
        hostNode: "k3s cluster",
        networkDeps: "Cluster network, ingress for web UI",
        storageDeps: "Longhorn PVC for repository data",
        relatedServices: ["ArgoCD (GitOps sync)", "Kubernetes (deployment target)", "Cloudflare (DNS)"],
        authMethod: "Local accounts, SSH keys, OAuth",
        exposureSurface: "Web UI (HTTPS), SSH (Git), API",
        knownRisks: ["Repository corruption", "Disk full", "Webhook failures"],
        securityIntegrations: ["SSH key management", "Access control per repo"],
        monitoring: "Health endpoint, pod metrics",
        logging: "Application logs, access logs",
        operationalCommands: [
            "git_repo_list — all repositories",
            "git_pr_list — open pull requests",
            "git_commit_list — recent commits",
        ],
        commonFailures: [
            "Push rejected → check disk space, repo permissions",
            "Webhook timeout → check target service, network",
            "ArgoCD out of sync → check webhook, polling interval",
        ],
        recommendations: [
            "Enable repository mirroring to offsite backup",
            "Set up branch protection on main branches",
            "Monitor PVC usage for repository growth",
            "Configure webhook retries for ArgoCD",
        ],
        upstreamDeps: ["Kubernetes", "Storage (Longhorn)", "DNS"],
        downstreamDeps: ["ArgoCD", "CI/CD pipelines", "All deployed applications"],
    },
};
// ── Service dependency map (for "map" mode) ──────────────────────────────────
const SERVICE_TREE = {
    unifi: {
        label: "UniFi Network",
        children: [
            { label: "VLANs", children: [{ label: "Management" }, { label: "IoT" }, { label: "Guest" }] },
            { label: "Switches (L2/L3)" },
            { label: "Access Points" },
            { label: "UDM Pro (Gateway)" },
            { label: "Tailscale (overlay)" },
            { label: "Cloudflare (DNS)" },
        ],
    },
    proxmox: {
        label: "Proxmox VE",
        children: [
            { label: "k3s Cluster", children: [
                    { label: "Longhorn (storage)" },
                    { label: "ArgoCD (GitOps)" },
                    { label: "Traefik (ingress)" },
                    { label: "fabric-* pods" },
                ] },
            { label: "Standalone VMs" },
            { label: "LXC Containers" },
            { label: "ZFS Storage" },
        ],
    },
    k8s: {
        label: "Kubernetes (k3s)",
        children: [
            { label: "Control Plane", children: [
                    { label: "k3s-master01" },
                    { label: "k3s-master02" },
                ] },
            { label: "Workers", children: [
                    { label: "k3s-worker01" },
                    { label: "k3s-worker02" },
                    { label: "k3s-worker03" },
                ] },
            { label: "Longhorn (storage)" },
            { label: "ArgoCD (GitOps)" },
            { label: "Traefik (ingress)" },
            { label: "Cloudflare Tunnel" },
        ],
    },
    cloudflare: {
        label: "Cloudflare",
        children: [
            { label: "DNS Zones" },
            { label: "Tunnels → k3s Ingress" },
            { label: "WAF / DDoS Protection" },
            { label: "SSL/TLS Termination" },
        ],
    },
    tailscale: {
        label: "Tailscale VPN",
        children: [
            { label: "Proxmox Hosts" },
            { label: "k3s Nodes" },
            { label: "Workstations" },
            { label: "Mobile Devices" },
            { label: "Subnet Routes → VLANs" },
            { label: "Exit Nodes" },
        ],
    },
    cve: {
        label: "CVE Scanner",
        children: [
            { label: "NVD Feed Sync" },
            { label: "Vulnerability Queue" },
            { label: "Sandfly (correlation)" },
        ],
    },
    sandfly: {
        label: "Sandfly Security",
        children: [
            { label: "Proxmox Hosts (scanned)" },
            { label: "k3s Nodes (scanned)" },
            { label: "Alert Pipeline" },
            { label: "CVE Correlation" },
        ],
    },
    git: {
        label: "Git (Forgejo)",
        children: [
            { label: "Repositories" },
            { label: "ArgoCD Webhooks" },
            { label: "Pull Requests" },
            { label: "Longhorn PVC (data)" },
        ],
    },
};
/** Render a tree as ASCII art */
function renderTree(node, prefix = "", isLast = true) {
    const connector = isLast ? "└── " : "├── ";
    const lines = [prefix + (prefix ? connector : "") + node.label];
    const childPrefix = prefix + (prefix ? (isLast ? "    " : "│   ") : "");
    if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const childIsLast = i === node.children.length - 1;
            const childConnector = childIsLast ? "└── " : "├── ";
            lines.push(childPrefix + childConnector + child.label);
            if (child.children) {
                const grandChildPrefix = childPrefix + (childIsLast ? "    " : "│   ");
                for (let j = 0; j < child.children.length; j++) {
                    const gc = child.children[j];
                    const gcConnector = j === child.children.length - 1 ? "└── " : "├── ";
                    lines.push(grandChildPrefix + gcConnector + gc.label);
                }
            }
        }
    }
    return lines.join("\n");
}
// ── Structured briefing formatter ────────────────────────────────────────────
function formatServiceBriefing(app, data, mode) {
    const meta = SERVICE_META[app];
    if (!meta)
        return formatGeneric(app, data);
    if (mode === "map") {
        const tree = SERVICE_TREE[app];
        if (!tree)
            return `No dependency map available for ${app}.`;
        const lines = [
            `# ${meta.name} — Architecture Map`,
            "",
            "```",
            renderTree(tree),
            "```",
            "",
            "## Upstream Dependencies",
            ...meta.upstreamDeps.map((d) => `- ${d}`),
            "",
            "## Downstream Dependencies",
            ...meta.downstreamDeps.map((d) => `- ${d}`),
            "",
            "## Related Services",
            ...meta.relatedServices.map((s) => `- ${s}`),
        ];
        return lines.join("\n");
    }
    // ── Overview / Inspect mode ────────────────────────────────────────────────
    const lines = [];
    // SERVICE OVERVIEW
    lines.push("# SERVICE OVERVIEW", "", `**Name:** ${meta.name}`, `**Purpose:** ${meta.purpose}`, `**Role in Homelab:** ${meta.role}`, `**Criticality Level:** ${meta.criticality}`);
    // ARCHITECTURE
    lines.push("", "---", "", "# ARCHITECTURE", "", `**Deployment Type:** ${meta.deploymentType}`, `**Host / Node Location:** ${meta.hostNode}`, `**Network Dependencies:** ${meta.networkDeps}`, `**Storage Dependencies:** ${meta.storageDeps}`, "", "**Related Services:**", ...meta.relatedServices.map((s) => `- ${s}`));
    // CURRENT STATUS (from live data)
    lines.push("", "---", "", "# CURRENT STATUS", "");
    const statusFormatter = FORMATTERS[app];
    if (statusFormatter) {
        lines.push(statusFormatter(data));
    }
    else {
        lines.push(formatGeneric(app, data));
    }
    // RESOURCE UTILIZATION (extract from live data where available)
    const resources = extractResources(app, data);
    if (resources) {
        lines.push("", "---", "", "# RESOURCE UTILIZATION", "", resources);
    }
    // SECURITY POSTURE
    lines.push("", "---", "", "# SECURITY POSTURE", "", `**Authentication:** ${meta.authMethod}`, `**Exposure Surface:** ${meta.exposureSurface}`, "", "**Known Risks:**", ...meta.knownRisks.map((r) => `- ${r}`), "", "**Security Integrations:**", ...meta.securityIntegrations.map((s) => `- ${s}`));
    // OBSERVABILITY
    lines.push("", "---", "", "# OBSERVABILITY", "", `**Monitoring:** ${meta.monitoring}`, `**Logging:** ${meta.logging}`);
    // Inspect mode: add events/tasks if available
    if (mode === "inspect") {
        const events = extractRecentEvents(app, data);
        if (events) {
            lines.push("", "---", "", "# RECENT EVENTS", "", events);
        }
    }
    // DEPENDENCIES
    lines.push("", "---", "", "# DEPENDENCIES", "", "**Upstream:**", ...meta.upstreamDeps.map((d) => `- ${d}`), "", "**Downstream:**", ...meta.downstreamDeps.map((d) => `- ${d}`));
    // OPERATIONAL COMMANDS
    lines.push("", "---", "", "# OPERATIONAL COMMANDS", "", ...meta.operationalCommands.map((c) => `- \`${c.split(" — ")[0]}\` — ${c.split(" — ")[1] ?? ""}`));
    // COMMON FAILURE MODES
    lines.push("", "---", "", "# COMMON FAILURE MODES", "", ...meta.commonFailures.map((f) => `- ${f}`));
    // RECOMMENDATIONS
    lines.push("", "---", "", "# RECOMMENDATIONS", "", ...meta.recommendations.map((r, i) => `${i + 1}. ${r}`));
    return lines.join("\n");
}
/** Extract resource utilization from live data */
function extractResources(app, data) {
    if (app === "proxmox") {
        const cluster = data.cluster;
        if (!Array.isArray(cluster))
            return null;
        const nodes = cluster.filter((r) => r.type === "node");
        if (nodes.length === 0)
            return null;
        const lines = [];
        for (const n of nodes) {
            const cpuPct = n.cpu != null ? `${(Number(n.cpu) * 100).toFixed(1)}%` : "?";
            const memUsed = n.mem != null ? fmtBytes(Number(n.mem)) : "?";
            const memTotal = n.maxmem != null ? fmtBytes(Number(n.maxmem)) : "?";
            const memPct = n.mem != null && n.maxmem ? `${((Number(n.mem) / Number(n.maxmem)) * 100).toFixed(0)}%` : "";
            lines.push(`**${n.node}:** CPU ${cpuPct} | RAM ${memUsed}/${memTotal} (${memPct})`);
        }
        return lines.join("\n");
    }
    if (app === "k8s") {
        const cluster = data.cluster;
        if (!cluster)
            return null;
        return [
            `**Nodes:** ${cluster.nodeCount ?? "?"}`,
            `**Pods:** ${cluster.podCount ?? "?"} across ${cluster.namespaceCount ?? "?"} namespaces`,
        ].join("\n");
    }
    if (app === "unifi") {
        const inner = (data.status ?? data);
        const summary = inner.summary;
        if (!summary)
            return null;
        const devSummary = summary.devices;
        return [
            `**Devices:** ${devSummary?.total ?? "?"} total, ${devSummary?.online ?? "?"} online, ${devSummary?.offline ?? "?"} offline`,
            `**Hosts:** ${summary.hosts ?? "?"}`,
        ].join("\n");
    }
    return null;
}
/** Extract recent events from inspect data */
function extractRecentEvents(app, data) {
    // K8s events
    if (app === "k8s" && data.events) {
        const events = Array.isArray(data.events) ? data.events : data.events.events;
        if (!Array.isArray(events) || events.length === 0)
            return "No recent events.";
        const lines = [];
        for (const e of events.slice(0, 15)) {
            const type = e.type === "Warning" ? "⚠️" : "ℹ️";
            lines.push(`${type} **${e.reason ?? "?"}** — ${e.message ?? "?"} (${e.namespace ?? "?"}/${e.object ?? "?"})`);
        }
        return lines.join("\n");
    }
    // K8s pod problems
    if (app === "k8s" && data.problems) {
        const problems = Array.isArray(data.problems) ? data.problems : [];
        if (problems.length === 0)
            return "No pod problems detected.";
        const lines = [];
        for (const p of problems.slice(0, 10)) {
            lines.push(`🔴 **${p.name ?? "?"}** (${p.namespace ?? "?"}) — ${p.status ?? "?"}: ${p.reason ?? "?"}`);
        }
        return lines.join("\n");
    }
    // Proxmox tasks
    if (app === "proxmox" && data.tasks) {
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        if (tasks.length === 0)
            return "No recent tasks.";
        const lines = [];
        for (const t of tasks.slice(0, 10)) {
            const status = t.status === "OK" ? "✅" : "🔴";
            lines.push(`${status} **${t.type ?? "?"}** on ${t.node ?? "?"} — ${t.status ?? "?"}`);
        }
        return lines.join("\n");
    }
    // Sandfly alerts
    if (app === "sandfly" && data.alerts) {
        const alerts = Array.isArray(data.alerts) ? data.alerts : [];
        if (alerts.length === 0)
            return "No active alerts.";
        const lines = [];
        for (const a of alerts.slice(0, 10)) {
            lines.push(`⚠️ **${a.name ?? a.sandfly ?? "?"}** — ${a.severity ?? "?"} on ${a.host ?? "?"}`);
        }
        return lines.join("\n");
    }
    return null;
}
/** Fetch one tool from a fabric app */
async function callFabricTool(baseUrl, tool, args) {
    const res = await fetch(`${baseUrl}/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tool, arguments: args }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
        return null;
    return res.json();
}
/** Fetch live data from a fabric app, pre-format into a readable report.
 *  When mode is provided, uses the service intelligence briefing format. */
async function fetchFabricSummary(service, port, app, message, mode) {
    const baseUrl = `http://${service}.fabric-sdk:${port}`;
    // Select tool set based on mode
    let toolSpecs;
    if (mode === "inspect") {
        toolSpecs = INSPECT_TOOLS[app] ?? selectTools(app, message);
    }
    else if (mode === "overview" || mode === "map") {
        // Overview and map modes use the same data as overview (+ static metadata)
        toolSpecs = SUMMARY_TOOLS[app] ?? [{ tool: `${app}_health`, args: {}, key: "result" }];
    }
    else {
        toolSpecs = selectTools(app, message);
    }
    try {
        // Fetch all tools in parallel
        const results = await Promise.all(toolSpecs.map(async (spec) => {
            const result = await callFabricTool(baseUrl, spec.tool, spec.args ?? {});
            return { key: spec.key, result };
        }));
        // If single tool, pass result directly; if multi, merge into keyed object
        let data;
        if (results.length === 1) {
            data = results[0].result;
        }
        else {
            const merged = {};
            for (const r of results) {
                if (r.result != null)
                    merged[r.key] = r.result;
            }
            data = merged;
        }
        // Service intelligence briefing format for overview/inspect/map modes
        if (mode) {
            return formatServiceBriefing(app, data, mode);
        }
        // Legacy simple format for non-service queries
        const formatter = FORMATTERS[app];
        if (formatter)
            return formatter(data);
        return formatGeneric(app, data);
    }
    catch {
        return null;
    }
}
// ── History → CompletionMessage[] helper ──────────────────────────────────────
function historyToCompletionMessages(history) {
    return history.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
}
// ── Anthropic tool conversion ─────────────────────────────────────────────────
function fabricToolToAnthropic(tool) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    };
}
// ── Agentic loop with fabric tool_use ─────────────────────────────────────────
async function completeWithTools(anthropic, model, systemPrompt, history, tools, callTool, maxTokens) {
    let totalInput = 0;
    let totalOutput = 0;
    let messages = [...history];
    // Up to 10 tool-call rounds to prevent infinite loops
    for (let round = 0; round < 10; round++) {
        const response = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            tools,
            messages,
        });
        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
            const textBlock = response.content.find((b) => b.type === "text");
            const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
            return { content, inputTokens: totalInput, outputTokens: totalOutput };
        }
        if (response.stop_reason === "tool_use") {
            messages.push({ role: "assistant", content: response.content });
            const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
            // Max chars per tool result (~50k chars ≈ 12k tokens) to stay inside context limit
            const MAX_RESULT_CHARS = 50_000;
            const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
                try {
                    const result = await callTool(block.name, block.input);
                    let content = JSON.stringify(result);
                    if (content.length > MAX_RESULT_CHARS) {
                        content = content.slice(0, MAX_RESULT_CHARS) + `\n...[truncated — ${content.length - MAX_RESULT_CHARS} chars omitted]`;
                    }
                    return {
                        type: "tool_result",
                        tool_use_id: block.id,
                        content,
                    };
                }
                catch (err) {
                    return {
                        type: "tool_result",
                        tool_use_id: block.id,
                        is_error: true,
                        content: `Tool error: ${String(err)}`,
                    };
                }
            }));
            messages.push({ role: "user", content: toolResults });
            continue;
        }
        // Unknown stop_reason — return whatever text we have
        const textBlock = response.content.find((b) => b.type === "text");
        const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
        return { content, inputTokens: totalInput, outputTokens: totalOutput };
    }
    throw new Error("Agentic loop exceeded 10 rounds without finishing");
}
// ── sendMessage ───────────────────────────────────────────────────────────────
// Fire-and-forget helper — runs async work without blocking the caller
function fireAndForget(fn) {
    fn().catch(() => { });
}
export async function sendMessage(adapter, sessionId, content, maxTokens = 8192) {
    const isOllama = !!process.env.OLLAMA_ENDPOINT;
    const hasFabricGateway = typeof adapter.listFabricTools === "function" &&
        typeof adapter.callFabricTool === "function";
    // ── Parse service intelligence query ────────────────────────────────────────
    // Check for "service X", "inspect X", "map X", or bare service name triggers
    const serviceQuery = parseServiceQuery(content);
    // ── Parallel: fetch session + pre-fetch fabric data simultaneously ────────
    // Only fetch last 20 messages for LLM context — no need to load entire history
    const sessionPromise = adapter.getSession(sessionId, 20);
    const prefetchPromise = (async () => {
        // Service intelligence query → always fetch with mode-specific tools
        if (serviceQuery) {
            try {
                return await fetchFabricSummary(serviceQuery.route.service, serviceQuery.route.port, serviceQuery.app, content, serviceQuery.mode);
            }
            catch {
                return null;
            }
        }
        // Legacy Ollama pre-fetch for non-service queries
        if (isOllama) {
            const detected = detectFabricApp(content);
            if (!detected)
                return null;
            try {
                return await fetchFabricSummary(detected.service, detected.port, detected.app, content);
            }
            catch {
                return null;
            }
        }
        return null;
    })();
    const [session, fabricContext] = await Promise.all([sessionPromise, prefetchPromise]);
    if (session.state === "archived") {
        throw new Error(`Session ${sessionId} is archived. Resume it or create a new session.`);
    }
    // ── Deterministic short-circuit: report without LLM ───────────────────────
    // Service intelligence queries always short-circuit (the briefing IS the response)
    if (fabricContext && (serviceQuery || !needsLlmReasoning(content))) {
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: fabricContext,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return {
            messageId: sessionId,
            role: "assistant",
            content: fabricContext,
            inputTokens: 0,
            outputTokens: 0,
            model: session.model,
            routingLane: "deterministic",
        };
    }
    // ── Build history from session (already in memory) ────────────────────────
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
            role: m.role,
            content: m.content,
        })),
    ];
    // Inject fabric context before the user message if we have it (question path)
    if (fabricContext) {
        history.push({
            role: "user",
            content: `Use this live data to answer the user's question. Only reference what's in the data — do not invent information.\n\n${fabricContext}`,
        });
    }
    history.push({ role: "user", content });
    // ── Store user message — fire and forget ──────────────────────────────────
    fireAndForget(async () => {
        const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
        await adapter.embedAndStore(userMsg);
    });
    // ── LLM completion (the only blocking step the user waits for) ────────────
    //
    // Routing logic:
    //   1. Gateway + Claude  → full agentic tool_use loop (Claude calls tools natively)
    //   2. Gateway + Ollama  → pre-fetch gateway tools, inject results as context for Ollama
    //   3. No gateway        → straight to adapter.complete() (Ollama or Claude)
    //
    // This ensures Ollama sessions still get live infrastructure data via the gateway
    // without requiring native tool_use protocol support.
    let result;
    if (hasFabricGateway && !isOllama && process.env.ANTHROPIC_API_KEY) {
        // ── Path 1: Claude agentic loop (native tool_use) ─────────────────────
        let fabricTools = [];
        try {
            const allTools = await adapter.listFabricTools();
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            fabricTools = await selectRelevantTools(allTools, content, anthropic);
        }
        catch {
            // Gateway unreachable or filter failed — proceed without tools
        }
        if (fabricTools.length > 0) {
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            result = await completeWithTools(anthropic, session.model, session.systemPrompt, history, fabricTools.map(fabricToolToAnthropic), (name, args) => adapter.callFabricTool(name, args), maxTokens);
        }
        else {
            result = await adapter.complete(historyToCompletionMessages(history), { model: session.model, systemPrompt: session.systemPrompt, maxTokens });
        }
    }
    else if (hasFabricGateway && isOllama) {
        // ── Path 2: Ollama + gateway — fetch tool data, inject as context ─────
        // Ollama can't do native tool_use, but we can call the relevant tools
        // ourselves and inject the results so the model has live data.
        if (!fabricContext) {
            // MoE pre-fetch didn't fire (no keyword match) — try gateway tools
            let gatewayContext = null;
            try {
                const allTools = await adapter.listFabricTools();
                // Use keyword-based selection from the tool names/descriptions
                const relevant = allTools.filter((t) => {
                    const lower = content.toLowerCase();
                    const toolLower = (t.name + " " + t.description).toLowerCase();
                    // Check if any significant words from the user query appear in the tool
                    const queryWords = lower.split(/\s+/).filter((w) => w.length > 3);
                    return queryWords.some((w) => toolLower.includes(w));
                }).slice(0, 5);
                if (relevant.length > 0) {
                    const toolResults = await Promise.all(relevant.map(async (tool) => {
                        try {
                            const toolResult = await adapter.callFabricTool(tool.name, {});
                            return `### ${tool.name}\n${JSON.stringify(toolResult, null, 2)}`;
                        }
                        catch {
                            return null;
                        }
                    }));
                    const validResults = toolResults.filter(Boolean);
                    if (validResults.length > 0) {
                        gatewayContext = `Use this live infrastructure data to inform your response:\n\n${validResults.join("\n\n")}`;
                    }
                }
            }
            catch {
                // Gateway unreachable — proceed without extra context
            }
            if (gatewayContext) {
                history.splice(history.length - 1, 0, { role: "user", content: gatewayContext });
            }
        }
        result = await adapter.complete(historyToCompletionMessages(history), { model: session.model, systemPrompt: session.systemPrompt, maxTokens });
    }
    else {
        // ── Path 3: No gateway — straight completion ──────────────────────────
        result = await adapter.complete(historyToCompletionMessages(history), { model: session.model, systemPrompt: session.systemPrompt, maxTokens });
    }
    // ── Store assistant response — fire and forget ────────────────────────────
    fireAndForget(async () => {
        const assistantMsg = await adapter.addMessage({
            sessionId,
            role: "assistant",
            content: result.content,
            model: session.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
        });
        await adapter.embedAndStore(assistantMsg);
    });
    return {
        messageId: sessionId, // real ID is being stored async
        role: "assistant",
        content: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: session.model,
        routingLane: result.routingLane,
    };
}
// ── sendMessageStream (SSE streaming for Ollama) ─────────────────────────────
export async function* sendMessageStream(adapter, sessionId, content) {
    const ollamaConfig = createOllamaConfig();
    if (!ollamaConfig) {
        // Fall back to non-streaming — yield complete response at once
        const result = await sendMessage(adapter, sessionId, content);
        yield { token: result.content };
        yield { done: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model };
        return;
    }
    // ── Parse service intelligence query ────────────────────────────────────────
    const streamServiceQuery = parseServiceQuery(content);
    // ── Parallel: fetch session + pre-fetch fabric data ────────────────────────
    const sessionPromise = adapter.getSession(sessionId, 20);
    const prefetchPromise = (async () => {
        if (streamServiceQuery) {
            try {
                return await fetchFabricSummary(streamServiceQuery.route.service, streamServiceQuery.route.port, streamServiceQuery.app, content, streamServiceQuery.mode);
            }
            catch {
                return null;
            }
        }
        const detected = detectFabricApp(content);
        if (!detected)
            return null;
        try {
            return await fetchFabricSummary(detected.service, detected.port, detected.app, content);
        }
        catch {
            return null;
        }
    })();
    const [session, fabricContext] = await Promise.all([sessionPromise, prefetchPromise]);
    if (session.state === "archived") {
        yield { error: `Session ${sessionId} is archived.` };
        return;
    }
    // ── Deterministic short-circuit: report without LLM ───────────────────────
    if (fabricContext && (streamServiceQuery || !needsLlmReasoning(content))) {
        // Yield the entire report as one token — instant response
        yield { token: fabricContext };
        yield { done: true, inputTokens: 0, outputTokens: 0, model: "deterministic" };
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: fabricContext,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return;
    }
    // ── Build history ──────────────────────────────────────────────────────────
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
    ];
    if (fabricContext) {
        history.push({
            role: "user",
            content: `Use this live data to answer the user's question. Only reference what's in the data — do not invent information.\n\n${fabricContext}`,
        });
    }
    history.push({ role: "user", content });
    // ── Store user message — fire and forget ──────────────────────────────────
    fireAndForget(async () => {
        const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
        await adapter.embedAndStore(userMsg);
    });
    // ── Stream from Ollama ────────────────────────────────────────────────────
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of ollamaCompleteStream(ollamaConfig, session.systemPrompt, history)) {
        if (chunk.token) {
            fullContent += chunk.token;
            yield { token: chunk.token };
        }
        if (chunk.done) {
            inputTokens = chunk.inputTokens ?? 0;
            outputTokens = chunk.outputTokens ?? 0;
        }
    }
    yield { done: true, inputTokens, outputTokens, model: ollamaConfig.model };
    // ── Store assistant response — fire and forget ────────────────────────────
    fireAndForget(async () => {
        const assistantMsg = await adapter.addMessage({
            sessionId,
            role: "assistant",
            content: fullContent,
            model: session.model,
            inputTokens,
            outputTokens,
        });
        await adapter.embedAndStore(assistantMsg);
    });
}
export async function listMessages(adapter, sessionId, limit = 50, offset = 0) {
    return adapter.getMessages(sessionId, limit, offset);
}
export async function injectContext(adapter, sessionId, context, role = "system") {
    const msg = await adapter.addMessage({
        sessionId,
        role,
        content: context,
        metadata: { injected: true, injectedAt: new Date().toISOString() },
    });
    return { messageId: msg.id, sessionId, role };
}
//# sourceMappingURL=messages.js.map