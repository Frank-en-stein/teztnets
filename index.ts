import * as pulumi from "@pulumi/pulumi"
import * as gcp from "@pulumi/gcp"
import * as k8s from "@pulumi/kubernetes"
import * as fs from "fs"
import * as YAML from "yaml"

const cfg = new pulumi.Config()

// GCP Configuration
const gcpProject = cfg.get("gcp-project") || "jstz-dev-dbc1"
const gcpRegion = cfg.get("gcp-region") || "europe-west2"
const clusterName = cfg.get("cluster-name") || "riscvnet-cluster"

// Riscvnet secret keys from GCP Secret Manager
const riscvnetActivatorKey = cfg.requireSecret("riscvnet-activator-key")
const riscvnetBootstrap1Key = cfg.requireSecret("riscvnet-bootstrap1-key")
const riscvnetBootstrap2Key = cfg.requireSecret("riscvnet-bootstrap2-key")
const riscvnetBootstrap3Key = cfg.requireSecret("riscvnet-bootstrap3-key")
const riscvnetBootstrap4Key = cfg.requireSecret("riscvnet-bootstrap4-key")
const riscvnetBootstrap5Key = cfg.requireSecret("riscvnet-bootstrap5-key")
const riscvnetFaucetKey = cfg.requireSecret("riscvnet-faucet-key")

const faucetRecaptchaSiteKey = cfg.requireSecret("faucet-recaptcha-site-key")
const faucetRecaptchaSecretKey = cfg.requireSecret("faucet-recaptcha-secret-key")

// Reserve static IP for P2P endpoint (only P2P needs static IP for external nodes)
const p2pStaticIp = new gcp.compute.Address("riscvnet-p2p-ip", {
    name: "riscvnet-p2p-static-ip",
    region: gcpRegion,
    project: gcpProject,
})

// Reserve global static IP for Ingress
const ingressStaticIp = new gcp.compute.GlobalAddress("riscvnet-ingress-ip", {
    name: "riscvnet-ingress-static-ip",
    project: gcpProject,
})

// SSL certificates will be created after namespace and k8sProvider

// Metrics/Grafana temporarily disabled
// const metricsStaticIp = new gcp.compute.GlobalAddress("riscvnet-metrics-ip", {
//     name: "riscvnet-metrics-static-ip",
//     project: gcpProject,
// })

// DNS records will be created after LoadBalancers (at end of file)

// Create GKE cluster with Google Cloud Logging enabled
const cluster = new gcp.container.Cluster("riscvnet-cluster", {
    name: clusterName,
    location: gcpRegion,
    initialNodeCount: 1,
    removeDefaultNodePool: true,
    project: gcpProject,
    network: "dev-jstz-network",
    subnetwork: "dev-jstz-subnet",
    deletionProtection: false,
    loggingConfig: {
        enableComponents: ["SYSTEM_COMPONENTS", "WORKLOADS"],
    },
    monitoringConfig: {
        enableComponents: ["SYSTEM_COMPONENTS"],
    },
})

const nodePool = new gcp.container.NodePool("riscvnet-nodes", {
    name: "riscvnet-node-pool",
    location: gcpRegion,
    cluster: cluster.name,
    nodeCount: 3,
    project: gcpProject,
    nodeConfig: {
        machineType: "n1-standard-4",
        oauthScopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring",
        ],
    },
}, { ignoreChanges: ["nodeConfig"] })

// Create kubeconfig
const kubeconfig = pulumi.
    all([cluster.name, cluster.endpoint, cluster.masterAuth]).
    apply(([name, endpoint, masterAuth]) => {
        const context = `gke_${gcpProject}_${gcpRegion}_${name}`
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`
    })

// Kubernetes provider
const k8sProvider = new k8s.Provider("gke-k8s", {
    kubeconfig: kubeconfig,
}, { dependsOn: [nodePool] })

// Create namespace for riscvnet
const namespace = new k8s.core.v1.Namespace("riscvnet", {
    metadata: { 
        name: "riscvnet",
        labels: {
            "app": "riscvnet",
            "environment": "production",
        },
    },
}, { provider: k8sProvider })

// Create Kubernetes ManagedSslCertificate resources for GKE ingress
const rpcSslCert = new k8s.apiextensions.CustomResource("riscvnet-rpc-ssl-cert", {
    apiVersion: "networking.gke.io/v1",
    kind: "ManagedCertificate",
    metadata: {
        name: "riscvnet-rpc-ssl-cert",
        namespace: namespace.metadata.name,
    },
    spec: {
        domains: ["rpc.riscvnet.jstz.info"],
    },
}, { provider: k8sProvider })

const faucetSslCert = new k8s.apiextensions.CustomResource("riscvnet-faucet-ssl-cert", {
    apiVersion: "networking.gke.io/v1",
    kind: "ManagedCertificate",
    metadata: {
        name: "riscvnet-faucet-ssl-cert",
        namespace: namespace.metadata.name,
    },
    spec: {
        domains: ["faucet.riscvnet.jstz.info"],
    },
}, { provider: k8sProvider })

// Log sink creation removed due to insufficient permissions
// Logs are automatically exported to Google Cloud Logging via GKE cluster configuration

// Load and prepare tezos-k8s helm values
const helmValuesFile = fs.readFileSync("networks/riscvnet/values.yaml", "utf8")
const helmValues = YAML.parse(helmValuesFile)

// Inject secret keys
helmValues["accounts"]["activator"]["key"] = riscvnetActivatorKey
helmValues["accounts"]["bootstrap1"]["key"] = riscvnetBootstrap1Key
helmValues["accounts"]["bootstrap2"]["key"] = riscvnetBootstrap2Key
helmValues["accounts"]["bootstrap3"]["key"] = riscvnetBootstrap3Key
helmValues["accounts"]["bootstrap4"]["key"] = riscvnetBootstrap4Key
helmValues["accounts"]["bootstrap5"]["key"] = riscvnetBootstrap5Key

// Configure log export for Google Cloud Logging
helmValues["logExport"] = {
    enabled: true,
    destination: "gcp",
    project: gcpProject,
    cluster: cluster.name,
    namespace: namespace.metadata.name,
}

// LoadBalancer services created separately below via Pulumi (helm chart rpc_public/p2p_public not working)
// Service monitoring temporarily disabled
// helmValues["serviceMonitor"] = {
//     enabled: true,
// }

// Deploy tezos-k8s chart for riscvnet
const tezosChart = new k8s.helm.v3.Chart("riscvnet-tezos", {
    chart: "tezos-chain",
    version: "6.25.0",
    namespace: namespace.metadata.name,
    fetchOpts: {
        repo: "https://oxheadalpha.github.io/tezos-helm-charts/",
    },
    values: helmValues,
}, { provider: k8sProvider, dependsOn: [namespace] })

// Load faucet values
const faucetValuesFile = fs.readFileSync("networks/riscvnet/faucet_values.yaml", "utf8")
const faucetValues = YAML.parse(faucetValuesFile)

// Set faucet configuration
faucetValues["config"]["application"]["backendUrl"] = "https://faucet.riscvnet.jstz.info"
faucetValues["config"]["network"]["rpcUrl"] = "https://rpc.riscvnet.jstz.info"
faucetValues["authorizedHost"] = "*"
faucetValues["enableCaptcha"] = false
faucetValues["faucetPrivateKey"] = riscvnetFaucetKey

// Configure log export for faucet
faucetValues["logExport"] = {
    enabled: true,
    destination: "gcp",
    project: gcpProject,
    cluster: cluster.name,
    namespace: namespace.metadata.name,
}
// Faucet LoadBalancer created separately below via Pulumi

// Deploy faucet (recaptcha disabled) - Updated faucet_values.yaml
const faucetChart = new k8s.helm.v3.Chart("riscvnet-faucet", {
    chart: "tezos-faucet",
    version: "6.25.0",
    namespace: namespace.metadata.name,
    fetchOpts:
{
        repo: "https://oxheadalpha.github.io/tezos-helm-charts/",
    },
    values: faucetValues,
}, { provider: k8sProvider, dependsOn: [namespace] })

// Create ClusterIP services (internal only) for RPC and Faucet
const rpcService = new k8s.core.v1.Service("riscvnet-rpc-service", {
    metadata: {
        name: "riscvnet-rpc-service",
        namespace: namespace.metadata.name,
        annotations: {
            "cloud.google.com/neg": '{"ingress":true}',
            "cloud.google.com/backend-config": '{"default": "rpc-backend-config"}',
        },
    },
    spec: {
        type: "ClusterIP",
        ports: [{
            port: 8732,
            targetPort: 8732,
            protocol: "TCP",
            name: "rpc",
        }],
        selector: {
            node_class: "tezos-baking-node",
        },
    },
}, { provider: k8sProvider, dependsOn: [tezosChart] })

// Create BackendConfig for RPC service with proper health check
const rpcBackendConfig = new k8s.apiextensions.CustomResource("riscvnet-rpc-backend-config", {
    apiVersion: "cloud.google.com/v1",
    kind: "BackendConfig",
    metadata: {
        name: "rpc-backend-config",
        namespace: namespace.metadata.name,
    },
    spec: {
        healthCheck: {
            checkIntervalSec: 10,
            timeoutSec: 5,
            healthyThreshold: 1,
            unhealthyThreshold: 3,
            type: "HTTP",
            port: 8732,
            requestPath: "/version",
        },
        timeoutSec: 30,
    },
}, { provider: k8sProvider })

const faucetService = new k8s.core.v1.Service("riscvnet-faucet-service", {
    metadata: {
        name: "riscvnet-faucet-service",
        namespace: namespace.metadata.name,
    },
    spec: {
        type: "ClusterIP",
        ports: [{
            port: 8080,
            targetPort: 8080,
            protocol: "TCP",
            name: "http",
        }],
        selector: {
            app: "tezos-faucet",
        },
    },
}, { provider: k8sProvider, dependsOn: [faucetChart] })

// Create LoadBalancer service for P2P (port 9732 -> 9732) - external nodes need direct access
const p2pLoadBalancer = new k8s.core.v1.Service("riscvnet-p2p-lb", {
    metadata: {
        name: "riscvnet-p2p-lb",
        namespace: namespace.metadata.name,
    },
    spec: {
        type: "LoadBalancer",
        loadBalancerIP: p2pStaticIp.address,
        ports: [{
            port: 9732,
            targetPort: 9732,
            protocol: "TCP",
            name: "p2p",
        }],
        selector: {
            appType: "octez-node",
        },
    },
}, { provider: k8sProvider, dependsOn: [tezosChart] })

// Create GKE Ingress for HTTPS (RPC and Faucet)
const httpsIngress = new k8s.networking.v1.Ingress("riscvnet-https-ingress", {
    metadata: {
        name: "riscvnet-https-ingress",
        namespace: namespace.metadata.name,
        annotations: {
            "kubernetes.io/ingress.global-static-ip-name": ingressStaticIp.name,
            "networking.gke.io/managed-certificates": "riscvnet-rpc-ssl-cert,riscvnet-faucet-ssl-cert",
            "kubernetes.io/ingress.class": "gce",
        },
    },
    spec: {
        rules: [
            {
                host: "rpc.riscvnet.jstz.info",
                http: {
                    paths: [{
                        path: "/*",
                        pathType: "ImplementationSpecific",
                        backend: {
                            service: {
                                name: rpcService.metadata.name,
                                port: { number: 8732 },
                            },
                        },
                    }],
                },
            },
            {
                host: "faucet.riscvnet.jstz.info",
                http: {
                    paths: [{
                        path: "/*",
                        pathType: "ImplementationSpecific",
                        backend: {
                            service: {
                                name: faucetService.metadata.name,
                                port: { number: 8080 },
                            },
                        },
                    }],
                },
            },
        ],
    },
}, { provider: k8sProvider, dependsOn: [rpcService, faucetService, rpcSslCert, faucetSslCert] })

// Grafana and Prometheus temporarily disabled
// const grafanaDashboardsData: Record<string, string> = {}
// const dashboardFiles = ["dal-basic.json", "octez-compact.json"]
// dashboardFiles.forEach(file => {
//     grafanaDashboardsData[file] = fs.readFileSync(`./grafana_dashboards/${file}`, "utf8")
// })

// Create DNS records pointing to Ingress IP (for HTTPS) and P2P LoadBalancer IP
const rpcDnsRecord = new gcp.dns.RecordSet("riscvnet-rpc-dns", {
    name: "rpc.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

const faucetDnsRecord = new gcp.dns.RecordSet("riscvnet-faucet-dns", {
    name: "faucet.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

const p2pDnsRecord = new gcp.dns.RecordSet("riscvnet-p2p-dns", {
    name: "p2p.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [p2pLoadBalancer.status.loadBalancer.ingress[0].ip],
    project: gcpProject,
}, { dependsOn: [p2pLoadBalancer] })

// Export useful information
export const clusterNameOutput = cluster.name
export const kubeconfigOutput = kubeconfig
export const namespaceOutput = namespace.metadata.name
export const ingressStaticIpOutput = ingressStaticIp.address
export const rpcDomain = "rpc.riscvnet.jstz.info"
export const rpcEndpoint = "https://rpc.riscvnet.jstz.info"
export const faucetDomain = "faucet.riscvnet.jstz.info"
export const faucetEndpoint = "https://faucet.riscvnet.jstz.info"
export const p2pStaticIpOutput = p2pStaticIp.address
export const p2pDomain = "p2p.riscvnet.jstz.info"
export const p2pEndpoint = "p2p.riscvnet.jstz.info:9732"
export const rpcSslCertOutput = "riscvnet-rpc-ssl-cert"
export const faucetSslCertOutput = "riscvnet-faucet-ssl-cert"
export const logFilter = `resource.type="k8s_container" AND resource.labels.namespace_name="riscvnet"`
// export const metricsStaticIpOutput = metricsStaticIp.address
// export const metricsDomain = "metrics.riscvnet.jstz.info"
// export const metricsEndpoint = "http://metrics.riscvnet.jstz.info"

