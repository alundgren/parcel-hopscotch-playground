import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const localPath = (root: string, file: string) => relative(root, file).split(sep).join("/");
const moduleOwner = (file: string) => /^src\/modules\/([^/]+)\//.exec(file)?.[1];

export function guidanceBoundaryViolations(root: string): ReadonlyArray<string> {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) throw new Error("A TypeScript configuration is required for the guidance boundary check.");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const files = ts.sys.readDirectory(resolve(root, "src"), [".ts", ".tsx"]);
  const violations: Array<string> = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? "", ts.ScriptTarget.Latest, true);
    const from = localPath(root, file);
    const check = (specifier: ts.StringLiteralLike) => {
      const resolved = ts.resolveModuleName(specifier.text, file, config.options, ts.sys).resolvedModule;
      if (resolved === undefined) return;
      const to = localPath(root, resolved.resolvedFileName);
      if (!to.startsWith("src/")) return;
      let reason: string | undefined;
      if (from.startsWith("src/guidance/") && !to.startsWith("src/guidance/")) {
        reason = "The guidance runtime receives module contracts as arguments and cannot import application code.";
      } else if (from.startsWith("src/client/guidance/") && (to.startsWith("src/modules/") || to.startsWith("src/server/") || /src\/client\/(App|use-workspace)\.tsx?$/.test(to))) {
        reason = "Guidance components receive module definitions and application callbacks as props.";
      } else if (moduleOwner(to) !== undefined && moduleOwner(from) !== moduleOwner(to) && !/^src\/modules\/[^/]+\/index\.ts$/.test(to)) {
        reason = "Consumers must import a module's public index.ts.";
      }
      if (reason !== undefined) {
        const line = source.getLineAndCharacterOfPosition(specifier.getStart()).line + 1;
        violations.push(`${from}:${line} -> ${to}: ${reason}`);
      }
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) check(node.moduleSpecifier);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) check(node.argument.literal);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) check(argument);
        else if (from.startsWith("src/guidance/") || from.startsWith("src/client/guidance/") || moduleOwner(from) !== undefined) {
          violations.push(`${from}: Dynamic application imports must have a literal path so module boundaries can be checked.`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = guidanceBoundaryViolations(process.cwd());
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Guidance module import boundaries passed.\n");
}
