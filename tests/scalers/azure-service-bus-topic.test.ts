import * as sh from "shelljs"
import * as azure from "@azure/service-bus"
import test from "ava"
import { createNamespace, createYamlFile, waitForDeploymentReplicaCount } from "./helpers"

const connectionString = process.env["AZURE_SERVICE_BUS_CONNECTION_STRING"]
const topicName = "sb-topic"
const subscriptionName = "sb-subscription"

const testName = "test-azure-service-bus-topic"
const testNamespace = `${testName}-ns`
const secretName = `${testName}-secret`
const deploymentName = `${testName}-deployment`
const triggerAuthName = `${testName}-trigger-auth`
const scaledObjectName = `${testName}-scaled-object`

test.before(async t => {
    if (!connectionString) {
        t.fail("AZURE_SERVICE_BUS_CONNECTION_STRING environment variable is required for service bus tests")
    }

    sh.config.silent = true

    // Create topic within the Service Bus Namespace
    const serviceBusAdminClient = new azure.ServiceBusAdministrationClient(connectionString)
    const topicExists = await serviceBusAdminClient.topicExists(topicName)
    // Clean up (delete) topic if already exists and create again
    if (topicExists) {
        await serviceBusAdminClient.deleteTopic(topicName)
    }
    await serviceBusAdminClient.createTopic(topicName)

    // Create subscription within topic
    await serviceBusAdminClient.createSubscription(topicName, subscriptionName)

    // Create Kubernetes Namespace
    createNamespace(testNamespace)

    // Create Secret
    const base64ConStr = Buffer.from(connectionString).toString("base64")
    const secretFileName = createYamlFile(secretYaml.replace("{{CONNECTION}}", base64ConStr))

    t.is(
        sh.exec(`kubectl apply -f ${secretFileName} -n ${testNamespace}`).code,
        0,
        "Creating a secret should work"
    )

    // Create deployment
    t.is(
        sh.exec(`kubectl apply -f ${createYamlFile(deploymentYaml)} -n ${testNamespace}`).code,
        0,
        "Creating a deployment should work"
    )

    // Create trigger auth resource
    t.is(
        sh.exec(`kubectl apply -f ${createYamlFile(triggerAuthYaml)} -n ${testNamespace}`).code,
        0,
        "Creating a trigger authentication resource should work"
    )

    // Create scaled object
    t.is(
        sh.exec(`kubectl apply -f ${createYamlFile(scaledObjectYaml)} -n ${testNamespace}`).code,
        0,
        "Creating a scaled object should work"
    )

    t.true(await waitForDeploymentReplicaCount(0, deploymentName, testNamespace, 60, 1000), "Replica count should be 0 after 1 minute")
})

test.serial("Deployment should scale up with messages on service bus topic", async t => {
    // Send messages to service bus topic
    const serviceBusClient = new azure.ServiceBusClient(connectionString)
    const sender = serviceBusClient.createSender(topicName)

    const messages: azure.ServiceBusMessage[] = [
        {"body": "1"},
        {"body": "2"},
        {"body": "3"},
        {"body": "4"},
        {"body": "5"},
    ]

    await sender.sendMessages(messages)

    await serviceBusClient.close()

    // Scale out when messages available
    t.true(await waitForDeploymentReplicaCount(1, deploymentName, testNamespace, 60, 1000), "Replica count should be 1 after 1 minute")
})

test.serial("Deployment should scale down with messages on service bus topic", async t => {
    // Receive messages from service bus topic
    const serviceBusClient = new azure.ServiceBusClient(connectionString)
    const receiver = serviceBusClient.createReceiver(topicName, subscriptionName)

    var numOfReceivedMessages = 0

    while (numOfReceivedMessages < 5) {
        const messages = await receiver.receiveMessages(10, {
            maxWaitTimeInMs: 60 * 1000,
        })

        for (const message of messages) {
            await receiver.completeMessage(message)
            numOfReceivedMessages += 1
        }
    }

    await serviceBusClient.close()

    // Scale down when messages unavailable
    t.true(await waitForDeploymentReplicaCount(0, deploymentName, testNamespace, 60, 1000), "Replica count should be 0 after 1 minute")
})

test.after.always("Clean up E2E K8s objects", async t => {
    const resources = [
        `scaledobject.keda.sh/${scaledObjectName}`,
        `triggerauthentications.keda.sh/${triggerAuthName}`,
        `deployments.apps/${deploymentName}`,
        `secrets/${secretName}`,
    ]

    for (const resource of resources) {
        sh.exec(`kubectl delete ${resource} -n ${testNamespace}`)
    }

    sh.exec(`kubectl delete ns ${testNamespace}`)

    // Delete subscription
    const serviceBusAdminClient = new azure.ServiceBusAdministrationClient(connectionString)
    var response = await serviceBusAdminClient.deleteSubscription(topicName, subscriptionName)
    t.is(
        response._response.status,
        200,
        "Subscription deletion must succeed"
    )

    response = await serviceBusAdminClient.deleteTopic(topicName)
    t.is(
        response._response.status,
        200,
        "Topic deletion must succeed"
    )
})

// YAML Definitions for Kubernetes resources
// Secret
const secretYaml =
`apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${testNamespace}
type: Opaque
data:
  connection: {{CONNECTION}}
`

// Deployment
const deploymentYaml =
`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${testNamespace}
spec:
  replicas: 0
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
      - name: nginx
        image: nginx:1.16.1
`

// Trigger Authentication
const triggerAuthYaml =
`apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: ${triggerAuthName}
  namespace: ${testNamespace}
spec:
  secretTargetRef:
    - parameter: connection
      name: ${secretName}
      key: connection
`

// Scaled Object
const scaledObjectYaml =
`apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ${scaledObjectName}
  namespace: ${testNamespace}
  labels:
    deploymentName: ${deploymentName}
spec:
  scaleTargetRef:
    name: ${deploymentName}
  pollingInterval: 5
  cooldownPeriod: 10
  minReplicaCount: 0
  maxReplicaCount: 1
  triggers:
  - type: azure-servicebus
    metadata:
      topicName: ${topicName}
      subscriptionName: ${subscriptionName}
    authenticationRef:
      name: ${triggerAuthName}
`
