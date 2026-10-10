// Apache-2.0. Child layouts from native TypeScript pin 673a5f17, protocol 9.
export const nodeFields = {
    "QualifiedName": [
        "left",
        "right"
    ],
    "ComputedPropertyName": [
        "expression"
    ],
    "Decorator": [
        "expression"
    ],
    "IfStatement": [
        "expression",
        "thenStatement",
        "elseStatement"
    ],
    "DoStatement": [
        "statement",
        "expression"
    ],
    "WhileStatement": [
        "expression",
        "statement"
    ],
    "ForStatement": [
        "initializer",
        "condition",
        "incrementor",
        "statement"
    ],
    "ForInStatement": [
        "awaitModifier",
        "initializer",
        "expression",
        "statement"
    ],
    "ForOfStatement": [
        "awaitModifier",
        "initializer",
        "expression",
        "statement"
    ],
    "BreakStatement": [
        "label"
    ],
    "ContinueStatement": [
        "label"
    ],
    "ReturnStatement": [
        "expression"
    ],
    "WithStatement": [
        "expression",
        "statement"
    ],
    "SwitchStatement": [
        "expression",
        "caseBlock"
    ],
    "CaseBlock": [
        "clauses"
    ],
    "CaseClause": [
        "expression",
        "statements"
    ],
    "DefaultClause": [
        "expression",
        "statements"
    ],
    "ThrowStatement": [
        "expression"
    ],
    "TryStatement": [
        "tryBlock",
        "catchClause",
        "finallyBlock"
    ],
    "CatchClause": [
        "variableDeclaration",
        "block"
    ],
    "LabeledStatement": [
        "label",
        "statement"
    ],
    "ExpressionStatement": [
        "expression"
    ],
    "Block": [
        "statements"
    ],
    "VariableStatement": [
        "modifiers",
        "declarationList"
    ],
    "VariableDeclaration": [
        "name",
        "exclamationToken",
        "type",
        "initializer"
    ],
    "VariableDeclarationList": [
        "declarations"
    ],
    "ObjectBindingPattern": [
        "elements"
    ],
    "ArrayBindingPattern": [
        "elements"
    ],
    "Parameter": [
        "modifiers",
        "dotDotDotToken",
        "name",
        "questionToken",
        "type",
        "initializer"
    ],
    "BindingElement": [
        "dotDotDotToken",
        "propertyName",
        "name",
        "initializer"
    ],
    "MissingDeclaration": [
        "modifiers"
    ],
    "FunctionDeclaration": [
        "modifiers",
        "asteriskToken",
        "name",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "ClassDeclaration": [
        "modifiers",
        "name",
        "typeParameters",
        "heritageClauses",
        "members"
    ],
    "ClassExpression": [
        "modifiers",
        "name",
        "typeParameters",
        "heritageClauses",
        "members"
    ],
    "HeritageClause": [
        "types"
    ],
    "InterfaceDeclaration": [
        "modifiers",
        "name",
        "typeParameters",
        "heritageClauses",
        "members"
    ],
    "TypeAliasDeclaration": [
        "modifiers",
        "name",
        "typeParameters",
        "type"
    ],
    "JSTypeAliasDeclaration": [
        "modifiers",
        "name",
        "typeParameters",
        "type"
    ],
    "EnumMember": [
        "name",
        "initializer"
    ],
    "EnumDeclaration": [
        "modifiers",
        "name",
        "members"
    ],
    "ModuleBlock": [
        "statements"
    ],
    "ImportDeclaration": [
        "modifiers",
        "importClause",
        "moduleSpecifier",
        "attributes"
    ],
    "JSImportDeclaration": [
        "modifiers",
        "importClause",
        "moduleSpecifier",
        "attributes"
    ],
    "ExternalModuleReference": [
        "expression"
    ],
    "NamespaceImport": [
        "name"
    ],
    "NamedImports": [
        "elements"
    ],
    "ExportAssignment": [
        "modifiers",
        "type",
        "expression"
    ],
    "NamespaceExportDeclaration": [
        "modifiers",
        "name"
    ],
    "NamespaceExport": [
        "name"
    ],
    "NamedExports": [
        "elements"
    ],
    "ExportSpecifier": [
        "propertyName",
        "name"
    ],
    "CallSignature": [
        "typeParameters",
        "parameters",
        "type"
    ],
    "ConstructSignature": [
        "typeParameters",
        "parameters",
        "type"
    ],
    "Constructor": [
        "modifiers",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "GetAccessor": [
        "modifiers",
        "name",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "SetAccessor": [
        "modifiers",
        "name",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "IndexSignature": [
        "modifiers",
        "parameters",
        "type"
    ],
    "MethodSignature": [
        "modifiers",
        "name",
        "postfixToken",
        "typeParameters",
        "parameters",
        "type"
    ],
    "MethodDeclaration": [
        "modifiers",
        "asteriskToken",
        "name",
        "postfixToken",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "PropertySignature": [
        "modifiers",
        "name",
        "postfixToken",
        "type",
        "initializer"
    ],
    "PropertyDeclaration": [
        "modifiers",
        "name",
        "postfixToken",
        "type",
        "initializer"
    ],
    "ClassStaticBlockDeclaration": [
        "modifiers",
        "body"
    ],
    "BinaryExpression": [
        "modifiers",
        "left",
        "type",
        "operatorToken",
        "right"
    ],
    "PrefixUnaryExpression": [
        "operand"
    ],
    "PostfixUnaryExpression": [
        "operand"
    ],
    "YieldExpression": [
        "asteriskToken",
        "expression"
    ],
    "ArrowFunction": [
        "modifiers",
        "typeParameters",
        "parameters",
        "type",
        "equalsGreaterThanToken",
        "body"
    ],
    "FunctionExpression": [
        "modifiers",
        "asteriskToken",
        "name",
        "typeParameters",
        "parameters",
        "type",
        "body"
    ],
    "AsExpression": [
        "expression",
        "type"
    ],
    "SatisfiesExpression": [
        "expression",
        "type"
    ],
    "ConditionalExpression": [
        "condition",
        "questionToken",
        "whenTrue",
        "colonToken",
        "whenFalse"
    ],
    "PropertyAccessExpression": [
        "expression",
        "questionDotToken",
        "name"
    ],
    "ElementAccessExpression": [
        "expression",
        "questionDotToken",
        "argumentExpression"
    ],
    "CallExpression": [
        "expression",
        "questionDotToken",
        "typeArguments",
        "arguments"
    ],
    "NewExpression": [
        "expression",
        "typeArguments",
        "arguments"
    ],
    "MetaProperty": [
        "name"
    ],
    "NonNullExpression": [
        "expression"
    ],
    "SpreadElement": [
        "expression"
    ],
    "TemplateExpression": [
        "head",
        "templateSpans"
    ],
    "TemplateSpan": [
        "expression",
        "literal"
    ],
    "TaggedTemplateExpression": [
        "tag",
        "questionDotToken",
        "typeArguments",
        "template"
    ],
    "ParenthesizedExpression": [
        "expression"
    ],
    "ArrayLiteralExpression": [
        "elements"
    ],
    "ObjectLiteralExpression": [
        "properties"
    ],
    "SpreadAssignment": [
        "expression"
    ],
    "PropertyAssignment": [
        "modifiers",
        "name",
        "postfixToken",
        "type",
        "initializer"
    ],
    "ShorthandPropertyAssignment": [
        "modifiers",
        "name",
        "postfixToken",
        "type",
        "equalsToken",
        "objectAssignmentInitializer"
    ],
    "DeleteExpression": [
        "expression"
    ],
    "TypeOfExpression": [
        "expression"
    ],
    "VoidExpression": [
        "expression"
    ],
    "AwaitExpression": [
        "expression"
    ],
    "TypeAssertionExpression": [
        "type",
        "expression"
    ],
    "UnionType": [
        "types"
    ],
    "IntersectionType": [
        "types"
    ],
    "ConditionalType": [
        "checkType",
        "extendsType",
        "trueType",
        "falseType"
    ],
    "TypeOperator": [
        "type"
    ],
    "InferType": [
        "typeParameter"
    ],
    "ArrayType": [
        "elementType"
    ],
    "IndexedAccessType": [
        "objectType",
        "indexType"
    ],
    "TypeReference": [
        "typeName",
        "typeArguments"
    ],
    "ExpressionWithTypeArguments": [
        "expression",
        "typeArguments"
    ],
    "LiteralType": [
        "literal"
    ],
    "TypePredicate": [
        "assertsModifier",
        "parameterName",
        "type"
    ],
    "ImportAttribute": [
        "name",
        "value"
    ],
    "ImportAttributes": [
        "attributes"
    ],
    "TypeQuery": [
        "exprName",
        "typeArguments"
    ],
    "MappedType": [
        "readonlyToken",
        "typeParameter",
        "nameType",
        "questionToken",
        "type",
        "members"
    ],
    "TypeLiteral": [
        "members"
    ],
    "TupleType": [
        "elements"
    ],
    "NamedTupleMember": [
        "dotDotDotToken",
        "name",
        "questionToken",
        "type"
    ],
    "OptionalType": [
        "type"
    ],
    "RestType": [
        "type"
    ],
    "ParenthesizedType": [
        "type"
    ],
    "FunctionType": [
        "typeParameters",
        "parameters",
        "type"
    ],
    "ConstructorType": [
        "modifiers",
        "typeParameters",
        "parameters",
        "type"
    ],
    "TemplateLiteralType": [
        "head",
        "templateSpans"
    ],
    "TemplateLiteralTypeSpan": [
        "type",
        "literal"
    ],
    "SyntheticExpression": [
        "tupleNameSource"
    ],
    "PartiallyEmittedExpression": [
        "expression"
    ],
    "JsxElement": [
        "openingElement",
        "children",
        "closingElement"
    ],
    "JsxAttributes": [
        "properties"
    ],
    "JsxNamespacedName": [
        "namespace",
        "name"
    ],
    "JsxOpeningElement": [
        "tagName",
        "typeArguments",
        "attributes"
    ],
    "JsxSelfClosingElement": [
        "tagName",
        "typeArguments",
        "attributes"
    ],
    "JsxFragment": [
        "openingFragment",
        "children",
        "closingFragment"
    ],
    "JsxAttribute": [
        "name",
        "initializer"
    ],
    "JsxSpreadAttribute": [
        "expression"
    ],
    "JsxClosingElement": [
        "tagName"
    ],
    "JsxExpression": [
        "dotDotDotToken",
        "expression"
    ],
    "SyntaxList": [
        "children"
    ],
    "JSDoc": [
        "comment",
        "tags"
    ],
    "JSDocTypeExpression": [
        "type"
    ],
    "JSDocNonNullableType": [
        "type"
    ],
    "JSDocNullableType": [
        "type"
    ],
    "JSDocVariadicType": [
        "type"
    ],
    "JSDocOptionalType": [
        "type"
    ],
    "JSDocTypeTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocUnknownTag": [
        "tagName",
        "comment"
    ],
    "JSDocTemplateTag": [
        "tagName",
        "constraint",
        "typeParameters",
        "comment"
    ],
    "JSDocReturnTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocPublicTag": [
        "tagName",
        "comment"
    ],
    "JSDocPrivateTag": [
        "tagName",
        "comment"
    ],
    "JSDocProtectedTag": [
        "tagName",
        "comment"
    ],
    "JSDocReadonlyTag": [
        "tagName",
        "comment"
    ],
    "JSDocOverrideTag": [
        "tagName",
        "comment"
    ],
    "JSDocDeprecatedTag": [
        "tagName",
        "comment"
    ],
    "JSDocSeeTag": [
        "tagName",
        "nameExpression",
        "comment"
    ],
    "JSDocImplementsTag": [
        "tagName",
        "className",
        "comment"
    ],
    "JSDocAugmentsTag": [
        "tagName",
        "className",
        "comment"
    ],
    "JSDocSatisfiesTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocThrowsTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocThisTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocImportTag": [
        "tagName",
        "importClause",
        "moduleSpecifier",
        "attributes",
        "comment"
    ],
    "JSDocCallbackTag": [
        "tagName",
        "typeExpression",
        "name",
        "comment"
    ],
    "JSDocOverloadTag": [
        "tagName",
        "typeExpression",
        "comment"
    ],
    "JSDocTypedefTag": [
        "tagName",
        "typeExpression",
        "name",
        "comment"
    ],
    "JSDocSignature": [
        "typeParameters",
        "parameters",
        "type"
    ],
    "JSDocNameReference": [
        "name"
    ],
    "SourceFile": [
        "statements",
        "endOfFileToken"
    ],
    "ModuleDeclaration": [
        "modifiers",
        "name",
        "attributes",
        "body"
    ],
    "ImportEqualsDeclaration": [
        "modifiers",
        "name",
        "moduleReference"
    ],
    "ExportDeclaration": [
        "modifiers",
        "exportClause",
        "moduleSpecifier",
        "attributes"
    ],
    "ImportType": [
        "argument",
        "attributes",
        "qualifier",
        "typeArguments"
    ],
    "ImportClause": [
        "name",
        "namedBindings"
    ],
    "ImportSpecifier": [
        "propertyName",
        "name"
    ],
    "JSDocLink": [
        "name"
    ],
    "JSDocLinkPlain": [
        "name"
    ],
    "JSDocLinkCode": [
        "name"
    ],
    "TypeParameter": [
        "modifiers",
        "name",
        "constraint",
        "expression",
        "defaultType"
    ],
    "SyntheticReferenceExpression": [
        "expression",
        "thisArg"
    ],
    "JSDocTypeLiteral": [
        "jsdocPropertyTags"
    ],
    "JSDocParameterTag": [
        "tagName",
        "name",
        "typeExpression",
        "comment"
    ],
    "JSDocPropertyTag": [
        "tagName",
        "name",
        "typeExpression",
        "comment"
    ]
};
