import * as pulumi from "@pulumi/pulumi"
import * as gcp from "@pulumi/gcp"
import * as k8s from "@pulumi/kubernetes"

import { TezosChain } from "./tezos/chain"
import { TezosFaucet } from "./tezos/faucet"

const cfg = new pulumi.Config()

// GCP Configuration
const gcpProject = cfg.get("gcp-project") || "jstz-dev-dbc1"
const gcpRegion = cfg.get("gcp-region") || "europe-west2"
const clusterName = cfg.get("cluster-name") || "riscvnet-cluster"

// Riscvnet secret keys from Pulumi config
// All keys are stored as Pulumi secrets and passed to the Helm charts
const riscvnetActivatorKey = cfg.requireSecret("riscvnet-activator-key")
const riscvnetBootstrap1Key = cfg.requireSecret("riscvnet-bootstrap1-key")
const riscvnetBootstrap2Key = cfg.requireSecret("riscvnet-bootstrap2-key")
const riscvnetBootstrap3Key = cfg.requireSecret("riscvnet-bootstrap3-key")
const riscvnetBootstrap4Key = cfg.requireSecret("riscvnet-bootstrap4-key")
const riscvnetBootstrap5Key = cfg.requireSecret("riscvnet-bootstrap5-key")
const riscvnetFaucetKey = cfg.requireSecret("riscvnet-faucet-key")

// Create a GCP resource (Storage Bucket) for Bootstrap Smart Contracts
const activationBucket = new gcp.storage.Bucket("testnets-global-activation-bucket", {
  location: "US",
  uniformBucketLevelAccess: true,
  storageClass: "STANDARD",
  project: gcpProject,
});

// Set the bucket to be publicly readable
new gcp.storage.BucketIAMMember("publicRead", {
  bucket: activationBucket.name,
  role: "roles/storage.objectViewer",
  member: "allUsers",
});

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

// Create node pool for tezos-baking-node
const bakingNodePool = new gcp.container.NodePool("riscvnet-baking-nodes", {
    name: "riscvnet-baking-node-pool",
    location: gcpRegion,
    cluster: cluster.name,
    nodeCount: 1,
    project: gcpProject,
    nodeConfig: {
        machineType: "n1-standard-8",
        oauthScopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring",
        ],
        labels: {
            "node-class": "tezos-baking-node",
        },
        taints: [
            {
                key: "node-class",
                value: "tezos-baking-node",
                effect: "NO_SCHEDULE",
            },
        ],
    },
}, { ignoreChanges: ["nodeConfig"] })

// Create node pool for other nodes
const standardNodePool = new gcp.container.NodePool("riscvnet-standard-nodes", {
    name: "riscvnet-standard-node-pool",
    location: gcpRegion,
    cluster: cluster.name,
    nodeCount: 2,
    project: gcpProject,
    nodeConfig: {
        machineType: "n1-standard-2",
        oauthScopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring",
        ],
        labels: {
            "node-class": "standard",
        },
    },
}, { ignoreChanges: ["nodeConfig"] })

// Create kubeconfig
const kubeconfig = pulumi.all([cluster.name, cluster.endpoint, cluster.masterAuth]).apply(
    ([name, endpoint, masterAuth]) => {
        const context = `gke_${gcpProject}_${gcpRegion}_${name}`;
        const config = {
            apiVersion: "v1",
            clusters: [{
                cluster: {
                    "certificate-authority-data": masterAuth.clusterCaCertificate,
                    server: `https://${endpoint}`
                },
                name: context
            }],
            contexts: [{
                context: {
                    cluster: context,
                    user: context
                },
                name: context
            }],
            "current-context": context,
            kind: "Config",
            preferences: {},
            users: [{
                name: context,
                user: {
                    exec: {
                        apiVersion: "client.authentication.k8s.io/v1beta1",
                        command: "gke-gcloud-auth-plugin",
                        installHint: "Install gke-gcloud-auth-plugin for use with kubectl",
                        provideClusterInfo: true
                    }
                }
            }]
        };
        return JSON.stringify(config);
    }
)

// Kubernetes provider
const k8sProvider = new k8s.Provider("gke-k8s", {
    kubeconfig: kubeconfig,
}, { dependsOn: [bakingNodePool, standardNodePool] })

// Reserve global static IP for Ingress
const ingressStaticIp = new gcp.compute.GlobalAddress("riscvnet-ingress-ip", {
    name: "riscvnet-ingress-static-ip",
    project: gcpProject,
})

// Deploy riscvnet using TezosChain with bootstrap account keys
const riscvnet_chain = new TezosChain(
  {
    category: "Protocol Teztnets",
    humanName: "Riscvnet",
    description: "Test Chain for RISC-V protocol",
    activationBucket: activationBucket,
    helmValuesFile: "networks/riscvnet/values.yaml",
    bakingPrivateKey: riscvnetActivatorKey,
    chartRepoVersion: "7.2.0",
    bootstrapPeers: [],
    rpcUrls: [],
    indexers: [],
    networkStakes: true,
    // Pass all bootstrap account keys to be injected into helm values
    bootstrapAccountKeys: {
      bootstrap1: riscvnetBootstrap1Key,
      bootstrap2: riscvnetBootstrap2Key,
      bootstrap3: riscvnetBootstrap3Key,
      bootstrap4: riscvnetBootstrap4Key,
      bootstrap5: riscvnetBootstrap5Key,
      faucet: riscvnetFaucetKey,
    },
  },
  k8sProvider
)

// Deploy faucet using TezosFaucet class
new TezosFaucet(
  riscvnet_chain.name,
  {
    humanName: "Riscvnet",
    namespace: riscvnet_chain.namespace,
    helmValuesFile: "networks/riscvnet/faucet_values.yaml",
    faucetPrivateKey: riscvnetFaucetKey,
    // Google's official test keys that always pass validation
    // For production, replace with real keys from https://www.google.com/recaptcha/admin
    faucetRecaptchaSiteKey: pulumi.output("6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"),
    faucetRecaptchaSecretKey: pulumi.output("6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe"),
    chartRepoVersion: "7.2.0",
  },
  k8sProvider
)

// Create Kubernetes ManagedSslCertificate resources for GKE ingress
const rpcSslCert = new k8s.apiextensions.CustomResource("riscvnet-rpc-ssl-cert", {
    apiVersion: "networking.gke.io/v1",
    kind: "ManagedCertificate",
    metadata: {
        name: "riscvnet-rpc-ssl-cert",
        namespace: riscvnet_chain.namespace.metadata.name,
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
        namespace: riscvnet_chain.namespace.metadata.name,
    },
    spec: {
        domains: ["faucet.riscvnet.jstz.info", "faucet.sandbox.jstz.info"],
    },
}, { provider: k8sProvider })

const faucetApiSslCert = new k8s.apiextensions.CustomResource("riscvnet-faucet-api-ssl-cert", {
    apiVersion: "networking.gke.io/v1",
    kind: "ManagedCertificate",
    metadata: {
        name: "riscvnet-faucet-api-ssl-cert",
        namespace: riscvnet_chain.namespace.metadata.name,
    },
    spec: {
        domains: ["faucet-api.riscvnet.jstz.info", "faucet-api.sandbox.jstz.info"],
    },
}, { provider: k8sProvider })

// Note: tezos-k8s helm chart creates the services we need:
// - tezos-node-rpc: RPC service for octez node (port 8732)
// - tezos-faucet: Faucet service with both frontend (8080) and backend (3000)
// We just need to create the GKE Ingress pointing to these services

// Create BackendConfig for faucet backend to fix health check
const faucetBackendConfig = new k8s.apiextensions.CustomResource("riscvnet-faucet-backend-config", {
    apiVersion: "cloud.google.com/v1",
    kind: "BackendConfig",
    metadata: {
        name: "faucet-backend-config",
        namespace: riscvnet_chain.namespace.metadata.name,
    },
    spec: {
        healthCheck: {
            checkIntervalSec: 15,
            timeoutSec: 10,
            healthyThreshold: 1,
            unhealthyThreshold: 2,
            type: "HTTP",
            port: 3000,
            requestPath: "/info",  // Backend returns JSON on /info
        },
    },
}, { provider: k8sProvider })

// Patch the tezos-faucet service to add BackendConfig for port 3000
const faucetServicePatch = new k8s.core.v1.ServicePatch("riscvnet-faucet-service-patch", {
    metadata: {
        name: "tezos-faucet",
        namespace: riscvnet_chain.namespace.metadata.name,
        annotations: {
            "cloud.google.com/backend-config": '{"ports": {"3000": "faucet-backend-config"}}',
            "cloud.google.com/neg": '{"ingress": true}',
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [faucetBackendConfig],
})

// Create BackendConfig to fix GCE Load Balancer rate limiting and timeout issues
// This prevents 502s when the node is temporarily slow
const rpcBackendConfig = new k8s.apiextensions.CustomResource("riscvnet-rpc-backend-config", {
    apiVersion: "cloud.google.com/v1",
    kind: "BackendConfig",
    metadata: {
        name: "rpc-backend-config",
        namespace: riscvnet_chain.namespace.metadata.name,
    },
    spec: {
        healthCheck: {
            checkIntervalSec: 10,
            timeoutSec: 10,  // Increased from default 1sec to tolerate slow responses
            healthyThreshold: 1,
            unhealthyThreshold: 5,  // Increased from default 2 to be more tolerant of transient failures
            type: "HTTP",
            port: 8732,
            requestPath: "/version",  // Octez RPC returns 200 on /version, not /
        },
        timeoutSec: 60,  // Increased backend timeout from default 30sec
        connectionDraining: {
            drainingTimeoutSec: 60,
        },
    },
}, { provider: k8sProvider, dependsOn: [riscvnet_chain] })

// Patch the tezos-node-rpc service (created by Helm) to add BackendConfig annotation
// This removes the default rate limit of 1 req/sec/endpoint that causes 502s
const rpcServicePatch = new k8s.core.v1.ServicePatch("riscvnet-rpc-service-patch", {
    metadata: {
        name: "tezos-node-rpc",
        namespace: riscvnet_chain.namespace.metadata.name,
        annotations: {
            "cloud.google.com/backend-config": '{"default": "rpc-backend-config"}',
            "cloud.google.com/neg": '{"ingress": true}',
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [rpcBackendConfig, riscvnet_chain],
})

// Create GKE Ingress for HTTPS (using services created by helm charts)
new k8s.networking.v1.Ingress("riscvnet-https-ingress", {
    metadata: {
        name: "riscvnet-https-ingress",
        namespace: riscvnet_chain.namespace.metadata.name,
        annotations: {
            "kubernetes.io/ingress.global-static-ip-name": ingressStaticIp.name,
            "networking.gke.io/managed-certificates": "riscvnet-rpc-ssl-cert,riscvnet-faucet-ssl-cert,riscvnet-faucet-api-ssl-cert",
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
                                name: "tezos-node-rpc",
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
                                name: "tezos-faucet",
                                port: { number: 8080 },
                            },
                        },
                    }],
                },
            },
            {
                host: "faucet.sandbox.jstz.info",
                http: {
                    paths: [{
                        path: "/*",
                        pathType: "ImplementationSpecific",
                        backend: {
                            service: {
                                name: "tezos-faucet",
                                port: { number: 8080 },
                            },
                        },
                    }],
                },
            },
            {
                host: "faucet-api.riscvnet.jstz.info",
                http: {
                    paths: [{
                        path: "/*",
                        pathType: "ImplementationSpecific",
                        backend: {
                            service: {
                                name: "tezos-faucet",
                                port: { number: 3000 },
                            },
                        },
                    }],
                },
            },
            {
                host: "faucet-api.sandbox.jstz.info",
                http: {
                    paths: [{
                        path: "/*",
                        pathType: "ImplementationSpecific",
                        backend: {
                            service: {
                                name: "tezos-faucet",
                                port: { number: 3000 },
                            },
                        },
                    }],
                },
            },
        ],
    },
}, { provider: k8sProvider, dependsOn: [rpcSslCert, faucetSslCert, faucetApiSslCert] })

// Create DNS records pointing to Ingress IP
new gcp.dns.RecordSet("riscvnet-rpc-dns", {
    name: "rpc.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

new gcp.dns.RecordSet("riscvnet-faucet-dns", {
    name: "faucet.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

new gcp.dns.RecordSet("riscvnet-faucet-sandbox-dns", {
    name: "faucet.sandbox.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

new gcp.dns.RecordSet("riscvnet-faucet-api-dns", {
    name: "faucet-api.riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

new gcp.dns.RecordSet("riscvnet-faucet-api-sandbox-dns", {
    name: "faucet-api.sandbox.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [ingressStaticIp.address],
    project: gcpProject,
}, { dependsOn: [ingressStaticIp] })

// Create DNS record for P2P endpoint (LoadBalancer external IP)
// The P2P service is created in TezosChain and exposed as riscvnet_chain.p2pService
new gcp.dns.RecordSet("riscvnet-p2p-dns", {
    name: "riscvnet.jstz.info.",
    managedZone: "jstz-info",
    type: "A",
    ttl: 300,
    rrdatas: [riscvnet_chain.p2pService.status.loadBalancer.ingress[0].ip],
    project: gcpProject,
}, { dependsOn: [riscvnet_chain.p2pService] })

// Export useful information
export const clusterNameOutput = cluster.name
export const kubeconfigOutput = kubeconfig
export const namespaceOutput = riscvnet_chain.namespace.metadata.name
export const ingressStaticIpOutput = ingressStaticIp.address
export const rpcDomain = "rpc.riscvnet.jstz.info"
export const rpcEndpoint = "https://rpc.riscvnet.jstz.info"
export const faucetDomain = "faucet.riscvnet.jstz.info"
export const faucetEndpoint = "https://faucet.riscvnet.jstz.info"
export const p2pDomain = "riscvnet.jstz.info"
export const p2pEndpoint = riscvnet_chain.p2pService.status.loadBalancer.ingress[0].ip.apply(ip => `${ip}:9732`)
export const p2pPeerId = "idqnaeAw4oGfUEnKrLH2fZYRQo4Ev1"
export const logFilter = `resource.type="k8s_container" AND resource.labels.namespace_name="riscvnet"`