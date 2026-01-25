---
inclusion: always
---
# CLI
* use profile 'demo'
* do not use --tail options
* use sam logs for getting logs
* sam config will set the region and stackname
* use jq to format if possible
* Upload example: aws s3 cp demo/videos/sophie1.mp4 s3://scanner-app-storagestack-iy6vnjt40px-scannerbucket-wkbmlqr2m9gd/raw/685163c0-0031-70c5-c85e-1d7957761954/[filename]

# Callback examples
* **Test User ID:** 685163c0-0031-70c5-c85e-1d7957761954 (ericj@singledigit.net)
* **Approver email** ericdj@amazon.com
* Approve: `sam remote callback succeed [token] --result '{"approved":true,"reviewedBy":"ericdj@amazon.com","comments":"Content looks good"}'`
* Reject: `sam remote callback succeed [token] --result '{"approved":false,"reviewedBy":"ericdj@amazon.com","comments":"I do not like this"}'`
* Failure: `sam remote callback fail [token] --error-message [message] --error-type [type] --stack-trace [trace] --error-data [data]`  

# Resource Names
* **Stack Name:** scanner-app
* **S3 Bucket:** scanner-app-storagestack-iy6vnjt40px-scannerbucket-wkbmlqr2m9gd
* **DynamoDB Table:** scanner-table
* **Scanner Function:** scanner-app-ScannerFunction-XXXXX
* **Callback Function:** scanner-app-CallbackFunction-XXXXX
* **Region:** us-west-2

* No builds or deploys, I am using 'sam sync'
* Do NOT commit to the repo without explicit instructions
* Package all dependencies, do not rely on the Lambda defaults in the runtime
* Use powertools whenever possible https://docs.aws.amazon.com/powertools/typescript/latest/
    * Logging
    * Patterns
    * Tracing
    * Metrics
* When I ask a question, answer and make recommendations but wait for my approval to execute