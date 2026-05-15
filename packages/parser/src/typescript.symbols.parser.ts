/**
 * TypeScript/JavaScript symbol-level parser (Phase 1.3).
 *
 * Walks a single SourceFile (already parsed by ts-morph) and emits:
 *   - FunctionDeclaration + exported arrow-const → ParsedFunction
 *   - ClassDeclaration → ParsedClass + ParsedMethod for each member method
 *   - InterfaceDeclaration / TypeAliasDeclaration / EnumDeclaration → ParsedTypeDef
 *   - CALLS edges from each function/method body
 *   - USES edges from parameter / return types referencing local TypeDefs
 *
 * Cross-file resolution is intentionally deferred: an import binding is
 * carried as a `name@modulePath` reference id with `resolved: false` so
 * the extractor can downgrade those edges to MEDIUM confidence.
 *
 * Single-pass per AST node — no double traversal — to stay inside the
 * parser perf budget (CLAUDE.md §6).
 */

import {
  SyntaxKind,
  type SourceFile,
  type FunctionDeclaration,
  type ClassDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type FunctionExpression,
  type Node,
  type CallExpression,
  type VariableStatement,
  type ConstructorDeclaration,
} from 'ts-morph';
import { MAX_CYCLOMATIC_COMPLEXITY } from '@ekg/shared';
import type {
  ParsedSymbols,
  ParsedFunction,
  ParsedClass,
  ParsedMethod,
  ParsedTypeDef,
  ParsedCall,
  ParsedTypeUse,
  ParsedImport,
} from '@ekg/shared';

interface SymbolContext {
  readonly fileId: string;
  readonly filePath: string;
  /** Map of local symbol name → real id (for same-file resolution). */
  readonly localFunctions: Map<string, string>;
  /** Map of local class name → class id. */
  readonly localClasses: Map<string, string>;
  /** Map of class id → (method name → method id) for `this.foo()` resolution. */
  readonly classMethods: Map<string, Map<string, string>>;
  /** Map of imported binding → modulePath. Built once per file. */
  readonly importBindings: Map<string, string>;
  /** Map of local type name → typeDef id. */
  readonly localTypeDefs: Map<string, string>;
}

const COMPLEXITY_KINDS = new Set<number>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
]);

export class TypeScriptSymbolsParser {
  /**
   * Extract every symbol-level fact from a single source file.
   * `fileId` is the canonical graph id of the File node (`${repoUrl}:${filePath}`).
   */
  extract(
    source: SourceFile,
    fileId: string,
    filePath: string,
    imports: readonly ParsedImport[],
  ): ParsedSymbols {
    const ctx: SymbolContext = {
      fileId,
      filePath,
      localFunctions: new Map(),
      localClasses: new Map(),
      classMethods: new Map(),
      importBindings: this.buildImportBindings(imports),
      localTypeDefs: new Map(),
    };

    // First pass: register names → ids so callee/extends/type refs in the
    // second pass can resolve same-file targets without re-walking.
    this.registerLocalSymbols(source, ctx);

    const functions: ParsedFunction[] = [];
    const classes: ParsedClass[] = [];
    const methods: ParsedMethod[] = [];
    const typeDefs: ParsedTypeDef[] = [];
    const calls: ParsedCall[] = [];
    const typeUses: ParsedTypeUse[] = [];

    this.collectTypeDefs(source, fileId, typeDefs);
    this.collectFunctions(source, fileId, ctx, functions, calls, typeUses);
    this.collectClasses(source, fileId, ctx, classes, methods, calls, typeUses);

    return { functions, classes, methods, typeDefs, calls, typeUses };
  }

  // -- Registration pass ----------------------------------------------------

  private registerLocalSymbols(source: SourceFile, ctx: SymbolContext): void {
    for (const fn of source.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      ctx.localFunctions.set(name, this.functionId(ctx.fileId, name, fn.getStartLineNumber()));
    }

    for (const v of source.getVariableStatements()) {
      for (const decl of v.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init) continue;
        const k = init.getKind();
        if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue;
        const name = decl.getName();
        ctx.localFunctions.set(name, this.functionId(ctx.fileId, name, decl.getStartLineNumber()));
      }
    }

    for (const cls of source.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      const classId = this.classId(ctx.fileId, name, cls.getStartLineNumber());
      ctx.localClasses.set(name, classId);
      const methodMap = new Map<string, string>();
      for (const m of cls.getMethods()) {
        const mn = m.getName();
        methodMap.set(mn, this.methodId(classId, mn, m.getStartLineNumber()));
      }
      ctx.classMethods.set(classId, methodMap);
    }

    for (const iface of source.getInterfaces()) {
      ctx.localTypeDefs.set(iface.getName(), this.typeDefId(ctx.fileId, iface.getName(), iface.getStartLineNumber()));
    }
    for (const ta of source.getTypeAliases()) {
      ctx.localTypeDefs.set(ta.getName(), this.typeDefId(ctx.fileId, ta.getName(), ta.getStartLineNumber()));
    }
    for (const en of source.getEnums()) {
      ctx.localTypeDefs.set(en.getName(), this.typeDefId(ctx.fileId, en.getName(), en.getStartLineNumber()));
    }
  }

  private buildImportBindings(imports: readonly ParsedImport[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const imp of imports) {
      for (const spec of imp.specifiers) {
        const bare = spec.replace(/^\*\s+as\s+/, '').trim();
        if (!bare) continue;
        out.set(bare, imp.source);
      }
    }
    return out;
  }

  // -- TypeDefs -------------------------------------------------------------

  private collectTypeDefs(source: SourceFile, fileId: string, out: ParsedTypeDef[]): void {
    for (const iface of source.getInterfaces()) {
      out.push({
        id: this.typeDefId(fileId, iface.getName(), iface.getStartLineNumber()),
        name: iface.getName(),
        kind: 'interface',
        lineStart: iface.getStartLineNumber(),
        lineEnd: iface.getEndLineNumber(),
        isExported: iface.isExported(),
      });
    }
    for (const ta of source.getTypeAliases()) {
      out.push({
        id: this.typeDefId(fileId, ta.getName(), ta.getStartLineNumber()),
        name: ta.getName(),
        kind: 'type-alias',
        lineStart: ta.getStartLineNumber(),
        lineEnd: ta.getEndLineNumber(),
        isExported: ta.isExported(),
      });
    }
    for (const en of source.getEnums()) {
      out.push({
        id: this.typeDefId(fileId, en.getName(), en.getStartLineNumber()),
        name: en.getName(),
        kind: 'enum',
        lineStart: en.getStartLineNumber(),
        lineEnd: en.getEndLineNumber(),
        isExported: en.isExported(),
      });
    }
  }

  // -- Functions ------------------------------------------------------------

  private collectFunctions(
    source: SourceFile,
    fileId: string,
    ctx: SymbolContext,
    funcs: ParsedFunction[],
    calls: ParsedCall[],
    typeUses: ParsedTypeUse[],
  ): void {
    for (const fn of source.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const id = ctx.localFunctions.get(name)!;
      funcs.push(this.buildFunction(id, name, fn));
      this.collectCalls(fn, id, ctx, calls);
      this.collectFunctionTypeUses(fn, id, ctx, typeUses);
    }

    for (const v of source.getVariableStatements()) {
      this.collectArrowFunctionConsts(v, fileId, ctx, funcs, calls, typeUses);
    }
  }

  private collectArrowFunctionConsts(
    v: VariableStatement,
    _fileId: string,
    ctx: SymbolContext,
    funcs: ParsedFunction[],
    calls: ParsedCall[],
    typeUses: ParsedTypeUse[],
  ): void {
    const isExported = v.isExported();
    for (const decl of v.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const k = init.getKind();
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue;
      const name = decl.getName();
      const id = ctx.localFunctions.get(name);
      if (!id) continue;

      const fnNode = init as ArrowFunction | FunctionExpression;
      const sigStart = decl.getStartLineNumber();
      const sigEnd = decl.getEndLineNumber();
      const docComment = this.firstJsDoc(v);
      const isAsync = fnNode.isAsync();
      const signature = this.truncate(decl.getText(), 500);
      const complexity = this.cyclomatic(fnNode);

      funcs.push({
        id, name, signature, docComment,
        lineStart: sigStart, lineEnd: sigEnd,
        isExported, isAsync, complexity,
      });
      this.collectCalls(fnNode, id, ctx, calls);
      this.collectArrowTypeUses(fnNode, id, ctx, typeUses);
    }
  }

  private buildFunction(id: string, name: string, fn: FunctionDeclaration): ParsedFunction {
    return {
      id, name,
      signature: this.truncate(this.signatureText(fn), 500),
      docComment: this.firstJsDoc(fn),
      lineStart: fn.getStartLineNumber(),
      lineEnd: fn.getEndLineNumber(),
      isExported: fn.isExported(),
      isAsync: fn.isAsync(),
      complexity: this.cyclomatic(fn),
    };
  }

  // -- Classes / Methods ----------------------------------------------------

  private collectClasses(
    source: SourceFile,
    _fileId: string,
    ctx: SymbolContext,
    classes: ParsedClass[],
    methods: ParsedMethod[],
    calls: ParsedCall[],
    typeUses: ParsedTypeUse[],
  ): void {
    for (const cls of source.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      const id = ctx.localClasses.get(name)!;

      const extName = cls.getExtends()?.getExpression().getText();
      const extendsRef = extName ? this.resolveTypeRef(extName, ctx) : undefined;

      classes.push({
        id, name,
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        isExported: cls.isExported(),
        isAbstract: cls.isAbstract(),
        docComment: this.firstJsDoc(cls),
        extendsRef,
      });

      const methodMap = ctx.classMethods.get(id)!;
      for (const m of cls.getMethods()) {
        const methodId = methodMap.get(m.getName())!;
        methods.push(this.buildMethod(methodId, id, m));
        this.collectCalls(m, methodId, ctx, calls, id);
        this.collectMethodTypeUses(m, methodId, ctx, typeUses);
      }

      const ctor = cls.getConstructors()[0];
      if (ctor) this.collectCalls(ctor, id, ctx, calls, id);
    }
  }

  private buildMethod(id: string, classId: string, m: MethodDeclaration): ParsedMethod {
    const scope = m.getScope?.();
    const visibility: 'public' | 'private' | 'protected' =
      scope === 'private' ? 'private' : scope === 'protected' ? 'protected' : 'public';
    return {
      id, classId,
      name: m.getName(),
      signature: this.truncate(this.signatureText(m), 500),
      docComment: this.firstJsDoc(m),
      lineStart: m.getStartLineNumber(),
      lineEnd: m.getEndLineNumber(),
      isStatic: m.isStatic(),
      isAsync: m.isAsync(),
      visibility,
      complexity: this.cyclomatic(m),
    };
  }

  // -- Calls & type-use traversal ------------------------------------------

  private collectCalls(
    body: Node,
    sourceId: string,
    ctx: SymbolContext,
    out: ParsedCall[],
    enclosingClassId?: string,
  ): void {
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const resolved = this.resolveCallee(call, ctx, enclosingClassId);
      if (!resolved) continue;
      out.push({ sourceId, targetId: resolved.id, resolved: resolved.resolved });
    }
  }

  private resolveCallee(
    call: CallExpression,
    ctx: SymbolContext,
    enclosingClassId?: string,
  ): { id: string; resolved: boolean } | undefined {
    const expr = call.getExpression();
    const k = expr.getKind();

    if (k === SyntaxKind.Identifier) {
      const name = expr.getText();
      const local = ctx.localFunctions.get(name);
      if (local) return { id: local, resolved: true };
      const mod = ctx.importBindings.get(name);
      if (mod) return { id: `${name}@${mod}`, resolved: false };
      return undefined;
    }

    if (k === SyntaxKind.PropertyAccessExpression) {
      const prop = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
      const recv = prop.getExpression();
      const methodName = prop.getName();

      // this.foo() → enclosing class method
      if (recv.getKind() === SyntaxKind.ThisKeyword && enclosingClassId) {
        const mm = ctx.classMethods.get(enclosingClassId);
        const mid = mm?.get(methodName);
        if (mid) return { id: mid, resolved: true };
        return undefined;
      }

      // ImportedNs.fn() — receiver matches an imported binding
      if (recv.getKind() === SyntaxKind.Identifier) {
        const recvName = recv.getText();
        const mod = ctx.importBindings.get(recvName);
        if (mod) return { id: `${methodName}@${mod}`, resolved: false };
      }
    }

    return undefined;
  }

  private collectFunctionTypeUses(
    fn: FunctionDeclaration,
    sourceId: string,
    ctx: SymbolContext,
    out: ParsedTypeUse[],
  ): void {
    for (const param of fn.getParameters()) {
      this.pushTypeRef(param.getTypeNode()?.getText(), sourceId, ctx, out);
    }
    this.pushTypeRef(fn.getReturnTypeNode()?.getText(), sourceId, ctx, out);
  }

  private collectMethodTypeUses(
    m: MethodDeclaration,
    sourceId: string,
    ctx: SymbolContext,
    out: ParsedTypeUse[],
  ): void {
    for (const param of m.getParameters()) {
      this.pushTypeRef(param.getTypeNode()?.getText(), sourceId, ctx, out);
    }
    this.pushTypeRef(m.getReturnTypeNode()?.getText(), sourceId, ctx, out);
  }

  private collectArrowTypeUses(
    fn: ArrowFunction | FunctionExpression,
    sourceId: string,
    ctx: SymbolContext,
    out: ParsedTypeUse[],
  ): void {
    for (const param of fn.getParameters()) {
      this.pushTypeRef(param.getTypeNode()?.getText(), sourceId, ctx, out);
    }
    this.pushTypeRef(fn.getReturnTypeNode()?.getText(), sourceId, ctx, out);
  }

  private pushTypeRef(
    raw: string | undefined,
    sourceId: string,
    ctx: SymbolContext,
    out: ParsedTypeUse[],
  ): void {
    if (!raw) return;
    // Take the leading identifier (stripping generics, unions, etc.)
    const head = raw.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (!head) return;
    const local = ctx.localTypeDefs.get(head);
    if (local) {
      out.push({ sourceId, targetId: local, resolved: true });
      return;
    }
    const mod = ctx.importBindings.get(head);
    if (mod) {
      out.push({ sourceId, targetId: `${head}@${mod}`, resolved: false });
    }
  }

  private resolveTypeRef(name: string, ctx: SymbolContext): string | undefined {
    const local = ctx.localClasses.get(name);
    if (local) return local;
    const mod = ctx.importBindings.get(name);
    return mod ? `${name}@${mod}` : undefined;
  }

  // -- Helpers --------------------------------------------------------------

  private cyclomatic(node: Node): number {
    let c = 1;
    for (const n of node.getDescendants()) {
      if (COMPLEXITY_KINDS.has(n.getKind())) c++;
      else if (n.getKind() === SyntaxKind.BinaryExpression) {
        const op = n.asKind(SyntaxKind.BinaryExpression)?.getOperatorToken().getKind();
        if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) c++;
      }
      if (c >= MAX_CYCLOMATIC_COMPLEXITY) return MAX_CYCLOMATIC_COMPLEXITY;
    }
    return c;
  }

  private signatureText(node: FunctionDeclaration | MethodDeclaration | ConstructorDeclaration): string {
    const body = (node as { getBody?: () => Node | undefined }).getBody?.();
    if (!body) return node.getText();
    const full = node.getText();
    const idx = full.indexOf(body.getText());
    return idx > 0 ? full.slice(0, idx).trim() : full;
  }

  private firstJsDoc(node: { getJsDocs?: () => readonly { getDescription: () => string }[] }): string | undefined {
    const docs = node.getJsDocs?.();
    if (!docs || docs.length === 0) return undefined;
    const text = docs[0]?.getDescription().trim();
    return text ? this.truncate(text, 1000) : undefined;
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  private functionId(fileId: string, name: string, line: number): string {
    return `fn:${fileId}:${name}:${line}`;
  }

  private classId(fileId: string, name: string, line: number): string {
    return `cls:${fileId}:${name}:${line}`;
  }

  private methodId(classId: string, name: string, line: number): string {
    return `method:${classId}:${name}:${line}`;
  }

  private typeDefId(fileId: string, name: string, line: number): string {
    return `type:${fileId}:${name}:${line}`;
  }
}
