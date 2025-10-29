#!/bin/bash

set -euo pipefail

# Configuration
GCP_PROJECT="${GCP_PROJECT:-jstz-dev-dbc1}"
GCP_REGION="${GCP_REGION:-europe-west2}"
CLUSTER_NAME="${CLUSTER_NAME:-riscvnet-cluster}"
NAMESPACE="${NAMESPACE:-riscvnet}"

# Parse arguments
SKIP_CONFIRM=false
if [[ "${1:-}" == "--yes" ]] || [[ "${1:-}" == "-y" ]]; then
    SKIP_CONFIRM=true
fi

echo "=== Cleaning and recreating disks and pods in riscvnet cluster ==="
echo "Project: $GCP_PROJECT"
echo "Region: $GCP_REGION"
echo "Cluster: $CLUSTER_NAME"
echo "Namespace: $NAMESPACE"
echo ""

# Get GKE cluster credentials
echo "Step 1: Getting GKE cluster credentials..."
gcloud container clusters get-credentials "$CLUSTER_NAME" \
    --region "$GCP_REGION" \
    --project "$GCP_PROJECT"

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to get cluster credentials"
    exit 1
fi

# Verify namespace exists
echo ""
echo "Step 2: Verifying namespace exists..."
if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
    echo "ERROR: Namespace '$NAMESPACE' does not exist"
    exit 1
fi
echo "Namespace '$NAMESPACE' found"

# List current PVCs
echo ""
echo "Step 3: Listing current PVCs..."
PVC_COUNT=$(kubectl get pvc -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$PVC_COUNT" -eq 0 ]; then
    echo "No PVCs found in namespace '$NAMESPACE'"
else
    kubectl get pvc -n "$NAMESPACE"
fi

# List current pods
echo ""
echo "Step 4: Listing current pods..."
POD_COUNT=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$POD_COUNT" -eq 0 ]; then
    echo "No pods found in namespace '$NAMESPACE'"
else
    kubectl get pods -n "$NAMESPACE"
fi

# List current Jobs
echo ""
echo "Step 4b: Listing current Jobs..."
JOB_COUNT_INITIAL=$(kubectl get jobs -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$JOB_COUNT_INITIAL" -eq 0 ]; then
    echo "No jobs found in namespace '$NAMESPACE'"
else
    kubectl get jobs -n "$NAMESPACE"
fi

# Check for StatefulSets and save their replica counts
echo ""
echo "Step 4c: Checking for StatefulSets..."
STATEFULSET_COUNT=$(kubectl get statefulsets -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$STATEFULSET_COUNT" -gt 0 ]; then
    echo "Found StatefulSets:"
    kubectl get statefulsets -n "$NAMESPACE"
    # Save replica counts
    STATEFULSET_REPLICAS=()
    while IFS= read -r ss_name; do
        if [ -n "$ss_name" ]; then
            REPLICAS=$(kubectl get statefulset "$ss_name" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
            STATEFULSET_REPLICAS+=("$ss_name:$REPLICAS")
        fi
    done < <(kubectl get statefulsets -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}')
fi

# Confirm before proceeding
if [ "$SKIP_CONFIRM" = false ]; then
    echo ""
    read -p "Are you sure you want to delete all PVCs and pods in namespace '$NAMESPACE'? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Aborted"
        exit 0
    fi
else
    echo ""
    echo "Skipping confirmation (--yes flag provided)"
fi

# Scale down StatefulSets first (they will automatically recreate pods, blocking PVC deletion)
echo ""
echo "Step 5: Scaling down StatefulSets to release PVCs..."
if [ "$STATEFULSET_COUNT" -gt 0 ]; then
    echo "Found StatefulSets. Scaling them down to 0 replicas..."
    kubectl get statefulsets -n "$NAMESPACE" -o name | while read -r ss; do
        echo "  Scaling down $ss..."
        kubectl scale "$ss" --replicas=0 -n "$NAMESPACE"
    done
    echo "Waiting for StatefulSet pods to terminate..."
    # Wait up to 120 seconds for pods to terminate
    for i in {1..24}; do
        REMAINING=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
        if [ "$REMAINING" -eq 0 ]; then
            echo "  All StatefulSet pods terminated"
            break
        fi
        echo "  Waiting for pods to terminate... ($REMAINING remaining)"
        sleep 5
    done
else
    echo "No StatefulSets found"
fi

# Delete all Jobs (including activation jobs) - this will also delete their pods
echo ""
echo "Step 6: Deleting all Jobs (including activation jobs) in namespace '$NAMESPACE'..."
JOB_COUNT=$(kubectl get jobs -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$JOB_COUNT" -gt 0 ]; then
    echo "Found Jobs:"
    kubectl get jobs -n "$NAMESPACE"
    echo "  Deleting all jobs (this will also delete their pods)..."
    kubectl delete jobs --all -n "$NAMESPACE" --wait=false 2>&1 | grep -v "watch stream" || true
    echo "Jobs deleted, waiting for associated pods to terminate..."
    sleep 5
else
    echo "No jobs found"
fi

# Delete remaining pods (not managed by StatefulSets or Jobs)
echo ""
echo "Step 7: Deleting remaining pods in namespace '$NAMESPACE'..."
POD_COUNT=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$POD_COUNT" -gt 0 ]; then
    # Suppress watch errors (they're harmless warnings)
    kubectl delete pods --all -n "$NAMESPACE" --wait=false 2>&1 | grep -v "watch stream" || true
    echo "Pods deletion initiated..."
    echo "Waiting for pods to terminate..."
    # Wait up to 60 seconds for pods to terminate
    for i in {1..12}; do
        REMAINING=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
        if [ "$REMAINING" -eq 0 ]; then
            break
        fi
        echo "  Waiting for pods to terminate... ($REMAINING remaining)"
        sleep 5
    done
else
    echo "No pods to delete"
fi

# Delete all PVCs (this will clean up the disks)
echo ""
echo "Step 8: Deleting all PVCs in namespace '$NAMESPACE' (this will clean up the disks)..."
if [ "$PVC_COUNT" -gt 0 ]; then
    # Suppress watch errors (they're harmless warnings)
    kubectl delete pvc --all -n "$NAMESPACE" --wait=false 2>&1 | grep -v "watch stream" || true
    echo "PVCs deletion initiated..."
    echo "Waiting for PVCs and disks to be fully cleaned up..."
    # Wait up to 120 seconds for PVCs to terminate
    for i in {1..24}; do
        REMAINING=$(kubectl get pvc -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
        if [ "$REMAINING" -eq 0 ]; then
            echo "  All PVCs terminated and disks cleaned up"
            break
        fi
        TERMINATING=$(kubectl get pvc -n "$NAMESPACE" --no-headers 2>/dev/null | grep -c "Terminating" || echo "0")
        echo "  Waiting for PVCs to terminate... ($TERMINATING terminating)"
        sleep 5
    done
else
    echo "No PVCs to delete"
fi

# Scale StatefulSets back up to recreate pods with new PVCs
echo ""
echo "Step 9: Scaling StatefulSets back up (will create new PVCs with fresh storage)..."
if [ "$STATEFULSET_COUNT" -gt 0 ] && [ ${#STATEFULSET_REPLICAS[@]} -gt 0 ]; then
    for replica_info in "${STATEFULSET_REPLICAS[@]}"; do
        ss_name="${replica_info%%:*}"
        replicas="${replica_info##*:}"
        echo "  Scaling up $ss_name to $replicas replicas..."
        kubectl scale statefulset "$ss_name" --replicas="$replicas" -n "$NAMESPACE"
    done
    echo "Waiting for new pods and PVCs to be created..."
    sleep 10
fi

# Check if Helm release exists and can recreate resources
echo ""
echo "Step 10: Checking Helm releases and triggering Job recreation..."
HELM_RELEASES=$(helm list -n "$NAMESPACE" --short 2>/dev/null || echo "")

# The Helm release name for riscvnet is typically the namespace name
HELM_RELEASE_NAME="$NAMESPACE"

if [ -n "$HELM_RELEASES" ]; then
    echo "Found Helm releases:"
    helm list -n "$NAMESPACE"
    echo ""
    # Try to upgrade Helm release to recreate Jobs
    if helm get manifest "$HELM_RELEASE_NAME" -n "$NAMESPACE" &>/dev/null; then
        echo "Attempting to upgrade Helm release '$HELM_RELEASE_NAME' to recreate activation job..."
        # Get current chart path from Helm
        CURRENT_CHART=$(helm get values "$HELM_RELEASE_NAME" -n "$NAMESPACE" -o json 2>/dev/null | jq -r '.["_chart_path"] // empty' || echo "")
        if [ -n "$CURRENT_CHART" ]; then
            helm upgrade "$HELM_RELEASE_NAME" "$CURRENT_CHART" -n "$NAMESPACE" --reuse-values --force 2>&1 | grep -v "watch stream" || true
            echo "Helm upgrade initiated to recreate Jobs"
        else
            echo "Could not determine chart path. Please manually run: helm upgrade $HELM_RELEASE_NAME <chart> -n $NAMESPACE --reuse-values"
        fi
    fi
else
    echo "No Helm releases found via 'helm list'."
    echo "Resources are likely managed via Pulumi."
    echo ""

    # Check if we're in a Pulumi project and offer to refresh
    if [ -f "Pulumi.yaml" ] || [ -f "Pulumi.riscvnet.yaml" ]; then
        if [ "$SKIP_CONFIRM" = true ]; then
            echo "Pulumi configuration detected. Recreating activation job..."
            if command -v pulumi &>/dev/null; then
                # Change to script directory to ensure Pulumi can find the project
                SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
                PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
                cd "$PROJECT_DIR"

                echo "Step 1: Refreshing Pulumi state to detect deleted resources..."
                PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --stack riscvnet --yes --skip-preview 2>&1 | grep -v "Refreshing" | tail -20
                echo ""

                echo "Step 2: Running Pulumi up to recreate the activation job..."
                pulumi up --stack riscvnet --yes --skip-preview 2>&1 | tail -30
                echo ""
                echo "Waiting for resources to be recreated..."
                sleep 10
            else
                echo "WARNING: pulumi command not found. Please install Pulumi or run manually:"
                echo "  cd $(pwd)"
                echo "  PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --stack riscvnet --yes"
                echo "  pulumi up --stack riscvnet --yes"
            fi
        else
            read -p "Trigger Pulumi refresh and update to recreate activation job? (y/n): " trigger_update
            if [ "$trigger_update" = "y" ] || [ "$trigger_update" = "Y" ]; then
                if command -v pulumi &>/dev/null; then
                    # Change to script directory to ensure Pulumi can find the project
                    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
                    PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
                    cd "$PROJECT_DIR"

                    echo "Step 1: Refreshing Pulumi state to detect deleted resources..."
                    echo "Running: PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --stack riscvnet --yes"
                    PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --stack riscvnet --yes 2>&1 | grep -v "Refreshing" | tail -20
                    echo ""

                    echo "Step 2: Running Pulumi up to recreate the activation job..."
                    echo "Running: pulumi up --stack riscvnet --yes"
                    pulumi up --stack riscvnet --yes 2>&1 | tail -30
                    echo ""
                    echo "Waiting for resources to be recreated..."
                    sleep 10
                else
                    echo "WARNING: pulumi command not found. Please install Pulumi or run manually."
                fi
            else
                echo "Skipping Pulumi refresh and update."
                echo "To recreate the activation job manually, run:"
                echo "  cd $(pwd)"
                echo "  PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --stack riscvnet --yes"
                echo "  pulumi up --stack riscvnet --yes"
            fi
        fi
    else
        echo "Pulumi configuration not found."
        echo "To recreate the activation job, you may need to manually trigger your deployment process."
    fi
fi

# List final state
echo ""
echo "Step 11: Final state check..."
echo "Remaining PVCs:"
kubectl get pvc -n "$NAMESPACE" 2>/dev/null || echo "None"
echo ""
echo "Remaining pods:"
kubectl get pods -n "$NAMESPACE" 2>/dev/null || echo "None"
echo ""
echo "Remaining jobs:"
kubectl get jobs -n "$NAMESPACE" 2>/dev/null || echo "None"

echo ""
echo "=== Cleanup complete ==="
echo "All pods, PVCs (disks), and Jobs have been cleaned and recreated."
echo "If resources are managed by Helm/Pulumi, they should be automatically recreated."
echo "To verify recreation, run: kubectl get pods,pvc,jobs -n $NAMESPACE"

