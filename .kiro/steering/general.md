---
inclusion: always
---
* No builds or deploys, I am using 'sam sync'
* Do NOT commit to the repo without explicit instructions
* Package all dependencies, do not rely on the Lambda defaults in the runtime
* Use powertools whenever possible https://docs.aws.amazon.com/powertools/typescript/latest/
    * Logging
    * Patterns
* Durable functions reference https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html
* Whyen I ask a question, answer and make recommendations but wait for my approval to execute