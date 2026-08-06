## Tangram Databricks Connector

### How to configure databricks connector

#### Grant user access to workspace
To grant workspace access to the user creating a personal access token:

From the left menu of the account console, click Workspaces and then select a workspace to which you want to add the user.
From the tabs along the top of your workspace page, click the Permissions tab.
In the upper right of the Permissions page, click Add permissions.
In the Add permissions dialog, enter the following details:
For User, group, or service principal, select the user to grant access.
For Permission, click the dropdown and select workspace User.


#### Generate a personal access token
You can generate a personal access token in your Databricks workspace to the authenticate the integration in Tangram.

To generate a personal access token:

1. From the top right of your Databricks workspace, click your Databricks username, and then from the dropdown, click User Settings.
2. Under the Settings menu, click Developer.
3. On the Developer page, next to Access tokens, click Manage.
4. On the Access tokens page, click the Generate new token button.
5. In the Generate new token dialog:
   * For Comment, enter a description of the token's intended use — for example, Tangram Connector.
   * For Lifetime (days), consider removing the number. This will allow the token to be used indefinitely — it will not need to be refreshed.
   
6. Copy and save the generated token in a secure location, and then click Done.