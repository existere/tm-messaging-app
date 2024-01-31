// Import the AWS CDK
import { Construct } from 'constructs';
import { resolve } from "path";
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as apig from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { CloudFormationStackProps } from './cloud_formation-stack-props';
import { CloudFormationStackUtils } from './cloud_formation-stack-util';

/**
 * @class CloudFormationStack
 * @classdesc Creates a Cloudformation stack with a website, a DynamoDB table, a Lambda function, and a CloudWatch dashboard.
*/
export class CloudFormationStack extends cdk.Stack {
    
    /**
     * @constructor
     * @param {Construct} scope The AWS CDK construct scope.
     * @param {string} id The stack ID.
     * @param {CloudFormationStackProps} props The stack properties.
    */
    constructor(scope: Construct, id: string, props: CloudFormationStackProps) {
        super(scope, id, props);
        const messageTable: dynamodb.Table = this.createOrUpdateMessageTable(props);

        const serverLambdaId: string = "ServerLambda"
        const serverLambda: lambda.Function = this.createOrUpdateServerLambda(
            serverLambdaId, messageTable, props);
        const messageApi: apig.SpecRestApi = this.createOrUpdateMessageServerApi(
            serverLambdaId, serverLambda, props);

        const websiteUser: iam.User = this.createOrUpdateWebsiteUser(messageApi, props);
        const websiteBucket: s3.Bucket = this.createOrUpdateWebsiteBucket(messageApi, props);
            
        // Create or update CloudWatch dashboard
        this.createOrUpdateCloudWatchDashboard(serverLambda, messageApi, messageTable, props);
        }
        
    /**
     * @private
     * @method createOrUpdateMessageTable
     * @description Creates a DynamoDB table to store messages.
     * @param {CloudFormationStackProps} props The stack properties.
     * @returns {dynamodb.Table} The DynamoDB table.
     */
    createOrUpdateMessageTable(props: CloudFormationStackProps): dynamodb.Table {
        // Create DynamoDB table to store the messages. Encrypted by default.
        const tableId: string = 'MessageTable';
        return new dynamodb.Table(this, tableId, {
            tableName: CloudFormationStackUtils.getResourceName(tableId, props),
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
        });
    }
        
    /**
     * @private
     * @method createOrUpdateServerLambda
     * @description Creates a Lambda function to handle requests to the website.
     * @param {string} serverLambdaId The function id of the server lambda.
     * @param {dynamodb.Table} messageTable The DynamoDB table to store messages.
     * @param {CloudFormationStackProps} props The stack properties.
     * @returns {lambda.Function} The Lambda function.
     */
    createOrUpdateServerLambda(
        serverLambdaId: string,
        messageTable: dynamodb.Table,
        props: CloudFormationStackProps
    ): lambda.Function {

        // Define lambda function code as assets to be deployed with the rest of
        // the infrastructure.
        const lambdaAsset: assets.Asset = new assets.Asset(this, "LambdaAssetsZip", {
            path: resolve(__dirname, "../../lambda/src"),
        })

        // Create a Server Lambda resource
        const serverLambda: lambda.Function = new lambda.Function(this, serverLambdaId, {
            functionName: CloudFormationStackUtils.getResourceName(serverLambdaId, props),
            runtime: lambda.Runtime.PYTHON_3_9,
            code: lambda.Code.fromBucket(
                lambdaAsset.bucket,
                lambdaAsset.s3ObjectKey,
            ),
            // Lambda should be very fast. Something is wrong if it takes > 5 seconds.
            timeout: cdk.Duration.seconds(5),
            handler: "entrypoint.handler", // TODO: Move constants to a configuration file.
            environment: {
                // Give lambda access to the table name.
                MESSAGE_TABLE_NAME: messageTable.tableName,
            }
        });

        // Give the server lambda full access to the DynamoDB table.
        messageTable.grantReadWriteData(serverLambda);

        // Return lambda resource.
        return serverLambda;
    }

    /**
    * @private
    * @method createOrUpdateMessageServerApi
    * @description Creates a REST API from an OpenAPI definiton to with a lambda backend.
    * @param {string} serverLambdaId The function id of the server lambda.
    * @param {lambda.Function} serverLambda The Lambda function that handles the api requests.
    * @param {CloudFormationStackProps} props The stack properties.
    * @returns {apig.SpecRestApi} The REST API.
    */
    createOrUpdateMessageServerApi(
        serverLambdaId: string,
        serverLambda: lambda.Function,
        props: CloudFormationStackProps
    ): apig.SpecRestApi {

        // Generate MessageServerApi from MessageServerAPI.json API definition with
        // aws integrations specified.
        const restApiId: string  = "MessageServerAPI";
        const restApi: apig.SpecRestApi = new apig.SpecRestApi(this, restApiId, {
            restApiName: CloudFormationStackUtils.getResourceName(restApiId, props),
            apiDefinition: CloudFormationStackUtils.restApiDefinitionWithLambdaIntegration(
                resolve(__dirname, "../../api_definition/MessageServerAPI.json"),
                serverLambdaId,
                props,
            ),
            deployOptions: { stageName: props.stageName },
        });

        // Give the the rest api execute ARN permission to invoke the lambda.
        serverLambda.addPermission("ApiInvokeLambdaPermission", {
            principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            action: "lambda:InvokeFunction",
            sourceArn: restApi.arnForExecuteApi(),
        });

        // Return api resource.
        return restApi;
    }

    /**
    * @private
    * @method createOrUpdateWebsiteUser
    * @description Creates an IAM user for the website to access the message api.
    * @param {apig.SpecRestApi} messageApi The API the user should will access to.
    * @returns {iam.User} The IAM user.
    */
    createOrUpdateWebsiteUser(messageApi: apig.SpecRestApi, props: CloudFormationStackProps): iam.User {
        const websiteUser = new iam.User(this, "WebsiteUser");

        // Create a website user and give them access to all the the api calls
        const messageApiAccessPolicyId: string = "MessageApiAccessPolicy";
        const websiteUserPolicy = new iam.Policy(this, messageApiAccessPolicyId, {
            policyName: CloudFormationStackUtils.getResourceName(messageApiAccessPolicyId, props),
            users: [websiteUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ["execute-api:Invoke"],
                    resources: [messageApi.arnForExecuteApi()],
                    effect: iam.Effect.ALLOW,
                }),
            ]
        });

        // Return website user.
        return websiteUser;
    }

    /**
    * @private
    * @method createOrUpdateWebsiteBucket
    * @description Creates a S3 bucket to host the website and sets up deployment to the bucket.
    * @param {apig.SpecRestApi} messageApi The API the website should call.
    * @param {CloudFormationStackProps} props The stack properties.
    * @returns {s3.Bucket} The S3 bucket.
    */
    createOrUpdateWebsiteBucket(
        messageApi: apig.SpecRestApi,
        props: CloudFormationStackProps
    ): s3.Bucket {

        // Create S3 Bucket to host the core website.
        const websiteBucketId: string = 'WebsiteBucket';
        const websiteBucket: s3.Bucket = new s3.Bucket(this, websiteBucketId, {
            // Bucket name must be lowercase.
            bucketName: CloudFormationStackUtils.getResourceName(websiteBucketId, props).toLowerCase(),
            websiteIndexDocument: "index.html", // TODO: Move constants to a configuration file.
            websiteErrorDocument: "404.html",
            publicReadAccess: true,

            // Note: block public access options supercedes other access policies.
            // Setting all of these to false does not allow the public to do anything
            // beyond what they are allowed by other explicit policies.
            blockPublicAccess: {
                blockPublicAcls: false,
                blockPublicPolicy: false,
                ignorePublicAcls: false,
                restrictPublicBuckets: false,
            }
        });

        // Create json data for the website to use at runtime.
        // The autogenerated API client doesn't know the api endpoing url at generation time
        // so it needs to be provided directly to the website bucket.
        const websiteConfig: any = {
            "apiEndpoint": messageApi.urlForPath(),
            // TODO: Require access keys for api using sigv4 auth.
            // "websiteUserAccessKey": props.websiteUserAccessKey,
            // "websiteUserSecretKey": props.websiteUserSecretKey,
        };

        // Create deployment.
        new s3deploy.BucketDeployment(this, 'WebsiteDeployment', {
            sources: [
                s3deploy.Source.asset(resolve(__dirname, "../../website/dist"), {
                    exclude: [
                        '*.DS_Store',
                        'config.json',
                    ],
                }),
                s3deploy.Source.jsonData("config.json", websiteConfig),
            ],
            destinationBucket: websiteBucket,
        });

        // Return bucket resource.
        return websiteBucket;
    }

    /**
     * @private
     * @method createOrUpdateCloudWatchDashboard
     * @description Creates or updates a CloudWatch dashboard with relevant metrics.
     * @param {lambda.Function} serverLambda The Lambda function.
     * @param {CloudFormationStackProps} props The stack properties.
     * @param {apig.SpecRestApi} messageApi The API the widgets will call.
     */
    createOrUpdateCloudWatchDashboard(
        serverLambda: lambda.Function, 
        messageApi: apig.SpecRestApi,
        messageTable: dynamodb.Table,
        props: CloudFormationStackProps
        ): void {

        // Create a CloudWatch dashboard
        const dashboardId: string = 'CloudWatchDashboard';
        const dashboard: cloudwatch.Dashboard = new cloudwatch.Dashboard(this, dashboardId, {
            dashboardName: CloudFormationStackUtils.getResourceName(dashboardId, props),
            start: '-P1D', // Show data for the last 1 day
        });

        /**
         * Custom metrics
         */

        // Calculate lambda error percentage
        const lambdaErrorPercentage = new cloudwatch.MathExpression({
            expression: "(errors / invocations) * 100",
            label: '% Error Rate',
            usingMetrics: {
                invocations: serverLambda.metricInvocations({ statistic: 'Sum' }),
                errors: serverLambda.metricErrors({ statistic: 'Sum' }),
            }
        });

        // Calculate % API Gateway 4XX errors
        const apiGateway4xxErrorPercentage = new cloudwatch.MathExpression({
            expression: 'm1 / m2 * 100',
            label: '% API Gateway 4XX Errors',
            usingMetrics: {
                m1: new cloudwatch.Metric({
                    metricName: '4XXError',
                    namespace: 'AWS/ApiGateway',
                    dimensionsMap: { ApiName: messageApi.restApiName },
                    statistic: 'Sum',
                }),
                m2: new cloudwatch.Metric({
                    metricName: 'Count',
                    namespace: 'AWS/ApiGateway',
                    dimensionsMap: { ApiName: messageApi.restApiName },
                    statistic: 'Sum',
                }),
            },
            period: cdk.Duration.minutes(5),
        });

        // Define API Gateway latency metrics for different percentiles
        const p99 = new cloudwatch.Metric({
            metricName: 'Latency',
            namespace: 'AWS/ApiGateway',
            dimensionsMap: { ApiName: messageApi.restApiName },
            statistic: 'p99',
        });

        const p95 = new cloudwatch.Metric({
            metricName: 'Latency',
            namespace: 'AWS/ApiGateway',
            dimensionsMap: { ApiName: messageApi.restApiName },
            statistic: 'p95',
        });

        const p50 = new cloudwatch.Metric({
            metricName: 'Latency',
            namespace: 'AWS/ApiGateway',
            dimensionsMap: { ApiName: messageApi.restApiName },
            statistic: 'p50',
        });

        /**
         * Cloudwatch Dashboard Widgets
         */

        // Lambda widgets - first row
        dashboard.addWidgets(

            // Lambda Invocation count 
            new cloudwatch.GraphWidget({
                title: 'Lambda Invocation Count',
                left: [serverLambda.metricInvocations()],
            }),

            // Lambda error percentage
            new cloudwatch.GraphWidget({
                title: 'Lambda Error Percentage',
                left: [lambdaErrorPercentage],
                view: cloudwatch.GraphWidgetView.TIME_SERIES,
                leftYAxis: {
                    label: 'Error Percentage',
                    min: 0,
                },
            }),

            // Lambda duration 
            new cloudwatch.GraphWidget({
                title: 'Lambda Function Duration',
                left: [serverLambda.metricDuration()],
            })
        );
        
        // DynamoDB widgets - second row
        dashboard.addWidgets(

            // DynamoDB Read and Write capacity utilization
            new cloudwatch.GraphWidget({
                title: 'DynamoDB Read and Write Capacity Utilization',
                left: [messageTable.metricConsumedReadCapacityUnits()],
                right: [messageTable.metricConsumedWriteCapacityUnits()],
            }),

            // DynamoDB read and write latency
            new cloudwatch.GraphWidget({
                title: 'DynamoDB Read and Write Latency',
                left: [messageTable.metricSuccessfulRequestLatency({dimensionsMap: {Operation: "GetItem"}})],
                right: [messageTable.metricSuccessfulRequestLatency({dimensionsMap: {Operation: "PutItem"}})],
            })
        );

        // API Gateway widgets - third row
        dashboard.addWidgets(

            // API Gateway 4XX error percentage
            new cloudwatch.GraphWidget({
                title: 'API Gateway 4XX Errors Percentage',
                left: [apiGateway4xxErrorPercentage],
                view: cloudwatch.GraphWidgetView.TIME_SERIES,
                leftYAxis: {
                    label: '4XX Error Percentage',
                    min: 0,
                    max: 100,
                },
            }),

            // API Gateway 5XX errors
            new cloudwatch.GraphWidget({
                title: 'API Gateway 5XX Errors',
                left: [new cloudwatch.Metric({
                    metricName: '5XXError',
                    namespace: 'AWS/ApiGateway',
                    dimensionsMap: { ApiName: messageApi.restApiName },
                    statistic: 'Sum',
                })],
            }),

            // API Gateway latency
            new cloudwatch.GraphWidget({
                title: 'API Gateway Latency Percentiles',
                left: [p99, p95, p50],
                view: cloudwatch.GraphWidgetView.TIME_SERIES,
                leftYAxis: {
                    label: 'Latency (ms)',
                    min: 0,
                },
                period: cdk.Duration.minutes(5),
            })
        );
    }
}
