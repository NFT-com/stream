# NFT.com Infra Code

Our infrastructure is deployed using Pulumi

## Getting Started

### 1. Requirements

1. Pulumi CLI
2. Set `PULUMI_CONFIG_PASSPHRASE=""` env var

### 2. How to create New Pulumi Stack

1. Run `export PULUMI_CONFIG_PASSPHRASE=""` in your terminal and permanently set this in your global bash profile
2. Make sure you have configured AWS key and secret in `~/.aws/credentials`. If you have multiple profiles, 
   then you will need run `export AWS_PROFILE=$PROFILE_NAME`
3. Go to the folder where Pulumi project is initialized (e.g., location of `Pulumi.yaml`) 
4. Run this command
```
pulumi stack init $ENV.$NAME.$REGION
```

Replace `$ENV`, `$NAME`, `$REGION` with actual values. For example: `pulumi stack init dev.stream.us-east-1`

You can then go ahead and configure pulumi stack variable in the newly generated file. You can do this manually by following
the examples in the existing stack files or use the pulumi CLI.
