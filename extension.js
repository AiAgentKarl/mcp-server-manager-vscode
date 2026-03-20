// MCP Server Manager — VS Code Extension
// Browse, install and manage MCP servers for AI agents

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { SERVER_CATALOG, CATEGORIES } = require("./catalog");

// --- MCP Config Helpers ---

function getMcpConfigPath() {
  // .mcp.json im Workspace-Root suchen
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return path.join(workspaceFolders[0].uri.fsPath, ".mcp.json");
  }
  return null;
}

function readMcpConfig() {
  const configPath = getMcpConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }
  try {
    const content = fs.readFileSync(configPath, "utf8");
    return JSON.parse(content);
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpConfig(config) {
  const configPath = getMcpConfigPath();
  if (!configPath) {
    vscode.window.showErrorMessage(
      "Kein Workspace geöffnet — kann .mcp.json nicht erstellen."
    );
    return false;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return true;
}

function getInstalledServers() {
  const config = readMcpConfig();
  return Object.keys(config.mcpServers || {});
}

// --- Tree Data Providers ---

class InstalledServersProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    const installed = getInstalledServers();
    if (installed.length === 0) {
      const item = new vscode.TreeItem("No servers installed");
      item.description = "Use 'MCP: Browse Servers' to add some";
      return [item];
    }

    return installed.map((name) => {
      const item = new vscode.TreeItem(name);
      // Katalog-Info wenn verfügbar
      const catalogEntry = SERVER_CATALOG.find(
        (s) =>
          s.name === name ||
          s.name.replace("-mcp-server", "") === name ||
          s.displayName.toLowerCase().includes(name.toLowerCase())
      );
      if (catalogEntry) {
        item.description = `${catalogEntry.tools} tools`;
        item.tooltip = catalogEntry.description;
      }
      item.contextValue = "installedServer";
      item.iconPath = new vscode.ThemeIcon("server");
      return item;
    });
  }
}

class CatalogProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    const installed = getInstalledServers();

    if (!element) {
      // Root: Kategorien anzeigen
      return CATEGORIES.map((cat) => {
        const count = SERVER_CATALOG.filter((s) => s.category === cat).length;
        const item = new vscode.TreeItem(
          cat,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.description = `${count} servers`;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "category";
        return item;
      });
    }

    // Kategorie-Children: Server in dieser Kategorie
    const categoryName = element.label;
    const servers = SERVER_CATALOG.filter((s) => s.category === categoryName);

    return servers.map((server) => {
      const isInstalled = installed.some(
        (i) =>
          i === server.name ||
          i === server.name.replace("-mcp-server", "") ||
          server.name.includes(i)
      );
      const item = new vscode.TreeItem(server.displayName);
      item.description = isInstalled
        ? "✓ installed"
        : `${server.tools} tools`;
      item.tooltip = `${server.description}\n\nPackage: ${server.name}\nTools: ${server.tools}\nAPI Key: ${server.requiresApiKey ? "Required" : "Not needed"}`;
      item.iconPath = new vscode.ThemeIcon(
        isInstalled ? "check" : "extensions"
      );
      item.contextValue = isInstalled
        ? "catalogServerInstalled"
        : "catalogServer";
      item.command = {
        command: "mcpManager.showServerDetails",
        title: "Show Details",
        arguments: [server],
      };
      return item;
    });
  }
}

// --- Extension Activation ---

function activate(context) {
  // Tree Views registrieren
  const installedProvider = new InstalledServersProvider();
  const catalogProvider = new CatalogProvider();

  vscode.window.registerTreeDataProvider("mcpInstalled", installedProvider);
  vscode.window.registerTreeDataProvider("mcpCatalog", catalogProvider);

  // Status Bar
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  function updateStatusBar() {
    const count = getInstalledServers().length;
    statusBar.text = `$(server) MCP: ${count} servers`;
    statusBar.tooltip = "Click to browse MCP servers";
    statusBar.command = "mcpManager.browseServers";
    statusBar.show();
  }
  updateStatusBar();

  // --- Commands ---

  // Browse Servers (QuickPick)
  const browseCmd = vscode.commands.registerCommand(
    "mcpManager.browseServers",
    async () => {
      const installed = getInstalledServers();
      const items = SERVER_CATALOG.map((server) => {
        const isInstalled = installed.some(
          (i) => i === server.name || server.name.includes(i)
        );
        return {
          label: `${isInstalled ? "$(check) " : "$(extensions) "}${server.displayName}`,
          description: `${server.category} — ${server.tools} tools`,
          detail: server.description,
          server: server,
          isInstalled: isInstalled,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Search MCP servers...",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        if (selected.isInstalled) {
          const action = await vscode.window.showInformationMessage(
            `${selected.server.displayName} is already installed.`,
            "Remove",
            "View on GitHub"
          );
          if (action === "Remove") {
            await removeServer(selected.server);
            installedProvider.refresh();
            catalogProvider.refresh();
            updateStatusBar();
          } else if (action === "View on GitHub") {
            vscode.env.openExternal(vscode.Uri.parse(selected.server.github));
          }
        } else {
          await installServer(selected.server);
          installedProvider.refresh();
          catalogProvider.refresh();
          updateStatusBar();
        }
      }
    }
  );

  // Install Server
  const installCmd = vscode.commands.registerCommand(
    "mcpManager.installServer",
    async () => {
      const installed = getInstalledServers();
      const available = SERVER_CATALOG.filter(
        (s) => !installed.some((i) => i === s.name || s.name.includes(i))
      );

      if (available.length === 0) {
        vscode.window.showInformationMessage("All servers already installed!");
        return;
      }

      const items = available.map((s) => ({
        label: s.displayName,
        description: `${s.category} — ${s.tools} tools`,
        detail: s.description,
        server: s,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a server to install...",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        await installServer(selected.server);
        installedProvider.refresh();
        catalogProvider.refresh();
        updateStatusBar();
      }
    }
  );

  // Remove Server
  const removeCmd = vscode.commands.registerCommand(
    "mcpManager.removeServer",
    async () => {
      const installed = getInstalledServers();
      if (installed.length === 0) {
        vscode.window.showInformationMessage("No servers installed.");
        return;
      }

      const selected = await vscode.window.showQuickPick(installed, {
        placeHolder: "Select a server to remove...",
      });

      if (selected) {
        const config = readMcpConfig();
        delete config.mcpServers[selected];
        if (writeMcpConfig(config)) {
          vscode.window.showInformationMessage(`Removed ${selected}`);
          installedProvider.refresh();
          catalogProvider.refresh();
          updateStatusBar();
        }
      }
    }
  );

  // Show Installed
  const showInstalledCmd = vscode.commands.registerCommand(
    "mcpManager.showInstalled",
    () => {
      const installed = getInstalledServers();
      if (installed.length === 0) {
        vscode.window.showInformationMessage(
          "No MCP servers installed. Use 'MCP: Browse Servers' to add some."
        );
      } else {
        vscode.window.showInformationMessage(
          `Installed MCP servers: ${installed.join(", ")}`
        );
      }
    }
  );

  // Refresh Catalog
  const refreshCmd = vscode.commands.registerCommand(
    "mcpManager.refreshCatalog",
    () => {
      catalogProvider.refresh();
      installedProvider.refresh();
      updateStatusBar();
      vscode.window.showInformationMessage("MCP catalog refreshed.");
    }
  );

  // Server Details
  const detailsCmd = vscode.commands.registerCommand(
    "mcpManager.showServerDetails",
    (server) => {
      if (!server) return;
      const panel = vscode.window.createWebviewPanel(
        "mcpServerDetails",
        server.displayName,
        vscode.ViewColumn.One,
        {}
      );
      panel.webview.html = getServerDetailHtml(server);
    }
  );

  context.subscriptions.push(
    browseCmd,
    installCmd,
    removeCmd,
    showInstalledCmd,
    refreshCmd,
    detailsCmd,
    statusBar
  );
}

// --- Helper Functions ---

async function installServer(server) {
  const config = readMcpConfig();
  const shortName = server.name
    .replace("-mcp-server", "")
    .replace("-mcp", "");

  config.mcpServers[shortName] = {
    command: server.install.command,
    args: server.install.args,
  };

  if (writeMcpConfig(config)) {
    vscode.window.showInformationMessage(
      `✅ Installed ${server.displayName} — restart your MCP client to activate.`
    );
  }
}

async function removeServer(server) {
  const config = readMcpConfig();
  const shortName = server.name
    .replace("-mcp-server", "")
    .replace("-mcp", "");

  // Versuche verschiedene Namensformen
  delete config.mcpServers[shortName];
  delete config.mcpServers[server.name];

  if (writeMcpConfig(config)) {
    vscode.window.showInformationMessage(
      `Removed ${server.displayName}`
    );
  }
}

function getServerDetailHtml(server) {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
    h1 { color: var(--vscode-editor-foreground); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 8px; }
    .info { margin: 10px 0; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
    a { color: var(--vscode-textLink-foreground); }
  </style>
</head>
<body>
  <h1>${server.displayName}</h1>
  <p>${server.description}</p>
  <div class="info">
    <span class="badge">${server.category}</span>
    <span class="badge">${server.tools} tools</span>
    <span class="badge">${server.requiresApiKey ? "API key required" : "No API key needed"}</span>
  </div>
  <h2>Installation</h2>
  <pre><code>pip install ${server.name}</code></pre>
  <h2>MCP Config</h2>
  <pre><code>${JSON.stringify({ mcpServers: { [server.name.replace("-mcp-server", "")]: server.install } }, null, 2)}</code></pre>
  <h2>Links</h2>
  <p>
    <a href="${server.pypi}">PyPI</a> |
    <a href="${server.github}">GitHub</a>
  </p>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
