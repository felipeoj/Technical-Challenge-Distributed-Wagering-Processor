#!/bin/bash
# Creates the SQS queues inside LocalStack. Runs automatically from ready.d.
# The healthcheck waits for wager-events.fifo, which is created last.
set -euo pipefail

# Dead-letter queue first: the main queue's redrive policy needs its ARN.
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Safety net: after 5 receives without delete, SQS moves the message to the DLQ.
# The consumer also sends permanent errors to the DLQ explicitly.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Outbox events go to a separate queue, otherwise the consumer would read its own events.
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
