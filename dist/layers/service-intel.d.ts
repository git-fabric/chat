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
export interface ServiceProfile {
    name: string;
    fabricApp: string;
    purpose: string;
    role: string;
    criticality: "Low" | "Medium" | "High" | "Critical";
    architecture: {
        deploymentType: string;
        hostLocation: string;
        networkDeps: string[];
        storageDeps: string[];
        relatedServices: string[];
    };
    security: {
        authMethod: string;
        exposureSurface: string;
        knownRisks: string[];
        integrations: string[];
    };
    observability: {
        monitoring: string[];
        logging: string[];
        metrics: string;
        alerting: string;
    };
    dependencies: {
        upstream: string[];
        downstream: string[];
    };
    failureModes: Array<{
        issue: string;
        troubleshooting: string;
    }>;
    recommendations: string[];
}
export type BriefingMode = "overview" | "inspect" | "map";
export declare const INSPECT_TOOLS: Record<string, Array<{
    tool: string;
    args?: Record<string, unknown>;
    key: string;
}>>;
/** Parse user message for service intelligence triggers */
export declare function parseServiceQuery(message: string): {
    app: string;
    mode: BriefingMode;
} | null;
/** Resolve a service name (including aliases) to a fabric app key */
export declare function resolveAppName(name: string): string | null;
/** Get the service profile for an app */
export declare function getProfile(app: string): ServiceProfile | null;
/** Format the dependency tree for "map" mode */
export declare function formatMap(app: string): string;
/** Format a full service overview briefing (static + live data) */
export declare function formatBriefing(app: string, liveData: string | null, toolList: string[] | null): string;
//# sourceMappingURL=service-intel.d.ts.map