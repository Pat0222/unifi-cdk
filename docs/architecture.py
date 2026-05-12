#!/usr/bin/env python3
# Regenerate: python3 docs/architecture.py
# Requires:   pip install diagrams && brew install graphviz

from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import EC2, Lambda
from diagrams.aws.network import Route53, Route53HostedZone
from diagrams.aws.storage import S3
from diagrams.aws.security import SecretsManager
from diagrams.aws.management import Cloudwatch
from diagrams.aws.integration import SNS, Eventbridge, StepFunctions
from diagrams.aws.general import User, InternetAlt2
import os

graph_attr = {
    "fontsize": "13",
    "bgcolor": "white",
    "pad": "0.6",
    "splines": "ortho",
}

output = os.path.join(os.path.dirname(__file__), "architecture")

with Diagram("UniFi CDK Architecture", filename=output, outformat="png", show=False, direction="LR", graph_attr=graph_attr):

    with Cluster("Clients"):
        devices = User("UniFi Devices\n(switches / APs)")
        browser = User("Web Browser")

    with Cluster("Networking"):
        r53 = Route53HostedZone("Route 53\nyour-domain.com")
        eip = InternetAlt2("Elastic IP\n(fixed)")

    with Cluster("EC2 t3.small"):
        ec2 = EC2("nginx · UniFi App\n· MongoDB · Watchtower")

    with Cluster("Storage"):
        s3 = S3("S3\nBackups + SSL cert")
        sm = SecretsManager("Secrets Manager\nMongoDB · API key")

    with Cluster("Instance Rotation"):
        eb_rot = Eventbridge("EventBridge\nnew AMI · weekly")
        l_rot = Lambda("rotator")
        sfn = StepFunctions("Step Functions\ncutover")
        l_hc = Lambda("health check")
        l_co = Lambda("cutover")

    with Cluster("Observability"):
        eb_obs = Eventbridge("EventBridge\nhourly")
        l_bk = Lambda("backup check")
        l_nm = Lambda("network metrics")
        cw = Cloudwatch("CloudWatch\nalarms + dashboard")
        r53_hc = Route53("Route 53\nhealth check")
        sns = SNS("SNS → Email")

    # Traffic
    devices >> Edge(label="inform :8080") >> eip
    browser >> r53 >> eip >> ec2
    ec2 >> Edge(label="autobackup") >> s3
    sm >> Edge(label="credentials", style="dashed") >> ec2

    # Rotation
    eb_rot >> l_rot >> sfn
    sfn >> l_hc >> Edge(label="pass") >> l_co >> Edge(label="reassign") >> eip
    sfn >> Edge(label="success / failure") >> sns

    # Observability
    ec2 >> Edge(label="disk · mem · logs") >> cw
    eb_obs >> [l_bk, l_nm]
    [l_bk, l_nm] >> cw
    cw >> sns
    r53_hc >> sns
