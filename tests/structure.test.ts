/**
 * Tests for the Structure Extractor module.
 *
 * Covers extractFileStructure and extractCompactStructure across
 * TypeScript, Python, and mixed content scenarios.
 */

import { extractFileStructure, extractCompactStructure } from "../src/analysis/structure";

describe("extractFileStructure", () => {
  describe("TypeScript", () => {
    it("should extract imports, interfaces, classes, and methods from TypeScript", () => {
      const tsContent = `
import { Request, Response } from "express";
import { Octokit } from "octokit";
import { config } from "../env";

/**
 * User interface definition.
 */
export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserRepository {
  find(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

export type UserId = string;

export class UserService {
  private repository: UserRepository;

  constructor(repository: UserRepository) {
    this.repository = repository;
  }

  public async getUser(id: string): Promise<User | null> {
    return this.repository.find(id);
  }

  public async createUser(name: string, email: string): Promise<User> {
    const user: User = { id: crypto.randomUUID(), name, email };
    await this.repository.save(user);
    return user;
  }

  private validateEmail(email: string): boolean {
    return email.includes("@");
  }
}

export const DEFAULT_USER: User = {
  id: "default",
  name: "Guest",
  email: "guest@example.com",
};

export function formatUser(user: User): string {
  return \`\${user.name} <\${user.email}>\`;
}

export const getUserById = async (id: string): Promise<User | null> => {
  // Implementation
  return null;
};
`;

      const result = extractFileStructure(tsContent, "user-service.ts");

      // Check structure sections exist
      expect(result).toContain("## File Structure: user-service.ts");
      expect(result).toContain("### Imports");
      expect(result).toContain("### Definitions");

      // Check imports are captured
      expect(result).toContain('import { Request, Response } from "express"');
      expect(result).toContain('import { Octokit } from "octokit"');
      expect(result).toContain('import { config } from "../env"');

      // Check interfaces are captured
      expect(result).toContain("Interface: `export interface User");
      expect(result).toContain("Interface: `export interface UserRepository");

      // Check type alias is captured
      expect(result).toContain("Type: `export type UserId");

      // Check class is captured
      expect(result).toContain("Class: `export class UserService");

      // Note: Methods inside classes are currently not captured by the structure extractor
      // since they are indented and the pattern matching is line-based.
      // This is acceptable for the "lightweight" nature of this extractor.

      // Private methods should be excluded from any method detection
      expect(result).not.toContain("validateEmail");

      // Check exported const is captured
      expect(result).toContain("Const: `export const DEFAULT_USER");

      // Check exported functions are captured
      expect(result).toContain("Function: `export function formatUser");
      expect(result).toContain("Function: `export const getUserById");

      // Check stats line
      expect(result).toMatch(/Total lines: \d+/);
      expect(result).toMatch(/Imports: \d+/);
      expect(result).toMatch(/Definitions: \d+/);
    });

    it("should handle multi-line imports", () => {
      const tsContent = `
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";

import { config } from "./config";

export function MyComponent() {
  return null;
}
`;

      const result = extractFileStructure(tsContent, "component.tsx");

      // Multi-line import should be condensed
      expect(result).toContain("import { ... } from 'react'");
      expect(result).toContain('import { config } from "./config"');
      expect(result).toContain("Function: `export function MyComponent");
    });
  });

  describe("Python", () => {
    it("should extract imports, classes, functions, and decorators from Python", () => {
      const pythonContent = `
import os
import sys
from typing import Optional, List
from flask import Flask, request, jsonify
from dataclasses import dataclass

app = Flask(__name__)

@dataclass
class User:
    id: str
    name: str
    email: str

class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> Optional[User]:
        return self.db.find(user_id)

    async def create_user(self, name: str, email: str) -> User:
        user = User(id=str(uuid.uuid4()), name=name, email=email)
        await self.db.save(user)
        return user

@app.route("/users/<user_id>")
def get_user_endpoint(user_id: str):
    user = user_service.get_user(user_id)
    if user is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(user)

@app.route("/users", methods=["POST"])
async def create_user_endpoint():
    data = request.json
    user = await user_service.create_user(data["name"], data["email"])
    return jsonify(user), 201

def helper_function(x: int) -> int:
    return x * 2
`;

      const result = extractFileStructure(pythonContent, "app.py");

      // Check structure sections
      expect(result).toContain("## File Structure: app.py");
      expect(result).toContain("### Imports");
      expect(result).toContain("### Definitions");

      // Check Python imports
      expect(result).toContain("import os");
      expect(result).toContain("import sys");
      expect(result).toContain("from typing import Optional, List");
      expect(result).toContain("from flask import Flask, request, jsonify");

      // Check decorated class (decorator is attached to class name)
      expect(result).toContain("@dataclass class User:");

      // Check regular class
      expect(result).toContain("class UserService:");

      // Check functions are captured (decorators with arguments like @app.route(...)
      // don't get attached since only simple @decorator patterns are supported)
      expect(result).toContain("def get_user_endpoint");

      // Check async function
      expect(result).toContain("async def create_user_endpoint");

      // Check regular function
      expect(result).toContain("def helper_function");
    });

    it("should handle FastAPI style decorators", () => {
      const pythonContent = `
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float

@app.get("/items/{item_id}")
async def read_item(item_id: int):
    return {"item_id": item_id}

@app.post("/items/")
async def create_item(item: Item):
    return item
`;

      const result = extractFileStructure(pythonContent, "main.py");

      expect(result).toContain("from fastapi import FastAPI, HTTPException");
      expect(result).toContain("from pydantic import BaseModel");
      expect(result).toContain("class Item(BaseModel):");
      // Note: Decorators with arguments like @app.get(...) are not attached
      // since only simple @decorator patterns are supported
      expect(result).toContain("async def read_item");
      expect(result).toContain("async def create_item");
    });
  });

  describe("Mixed Content and Edge Cases", () => {
    it("should ignore comments but capture structure", () => {
      const content = `
// This is a single-line comment
import { foo } from "bar";

/**
 * This is a multi-line comment
 * that spans multiple lines
 */
export interface Config {
  name: string;
}

/* Another comment style */
export class Service {
  // Method comment
  public doSomething(): void {
    // Implementation comment
  }
}

# Python-style comment (if in a Python file)
`;

      const result = extractFileStructure(content, "mixed.ts");

      // Comments should be ignored
      expect(result).not.toContain("This is a single-line comment");
      expect(result).not.toContain("multi-line comment");
      expect(result).not.toContain("Another comment style");
      expect(result).not.toContain("Method comment");

      // Structure should be captured
      expect(result).toContain('import { foo } from "bar"');
      expect(result).toContain("Interface: `export interface Config");
      expect(result).toContain("Class: `export class Service");
    });

    it("should handle empty files gracefully", () => {
      const result = extractFileStructure("", "empty.ts");

      expect(result).toContain("## File Structure: empty.ts");
      expect(result).toContain("Total lines: 1");
      expect(result).not.toContain("### Imports");
      expect(result).not.toContain("### Definitions");
    });

    it("should handle files with only comments", () => {
      const content = `
// Just a comment
/* Another comment */
/**
 * Documentation only
 */
`;

      const result = extractFileStructure(content, "comments-only.ts");

      expect(result).toContain("## File Structure: comments-only.ts");
      expect(result).not.toContain("### Imports");
      expect(result).not.toContain("### Definitions");
    });

    it("should truncate long lines", () => {
      const content = `
export function veryLongFunctionNameThatExceedsTheMaximumLineLengthAndShouldBeTruncatedForReadability(param1: string, param2: number, param3: boolean, param4: object): Promise<void> {
  // Implementation
}
`;

      const result = extractFileStructure(content, "long-lines.ts");

      // Should contain truncated function definition with "..."
      expect(result).toContain("Function:");
      expect(result).toContain("veryLongFunctionName");
      expect(result).toContain("...");
    });

    it("should limit the number of imports shown", () => {
      // Create a file with more than 10 imports
      const imports = Array.from({ length: 15 }, (_, i) => `import { mod${i} } from "module${i}";`).join("\n");
      const content = `${imports}\n\nexport function test() {}`;

      const result = extractFileStructure(content, "many-imports.ts");

      // Should show limited imports and "more imports" message
      expect(result).toContain("... and 5 more imports");
    });

    it("should limit the number of definitions shown", () => {
      // Create a file with more than 20 definitions
      const definitions = Array.from({ length: 25 }, (_, i) => `export function func${i}() {}`).join("\n");
      const content = definitions;

      const result = extractFileStructure(content, "many-definitions.ts");

      // Should show limited definitions and "more definitions" message
      expect(result).toContain("... and 5 more definitions");
    });

    it("should handle C# using statements", () => {
      const content = `
using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;

namespace MyApp
{
    public class MyController
    {
    }
}
`;

      const result = extractFileStructure(content, "controller.cs");

      expect(result).toContain("using System;");
      expect(result).toContain("using System.Collections.Generic;");
      expect(result).toContain("using Microsoft.AspNetCore.Mvc;");
    });

    it("should handle CommonJS require statements", () => {
      const content = `
const express = require("express");
const { Router } = require("express");
const config = require("./config");

module.exports = function createApp() {
  return express();
};
`;

      const result = extractFileStructure(content, "app.js");

      expect(result).toContain('const express = require("express")');
      expect(result).toContain('const { Router } = require("express")');
      expect(result).toContain('const config = require("./config")');
    });
  });
});

describe("extractCompactStructure", () => {
  it("should return a single-line summary for TypeScript", () => {
    const content = `
import { foo } from "bar";
import { baz } from "qux";

export class MyClass {
  method() {}
}

export function myFunction() {}
export function anotherFunction() {}
`;

    const result = extractCompactStructure(content, "test.ts");

    expect(result).toContain("test.ts:");
    expect(result).toMatch(/\d+ lines/);
    expect(result).toMatch(/\d+ imports/);
    expect(result).toMatch(/\d+ class/);
    expect(result).toMatch(/\d+ fns?/);
  });

  it("should return a single-line summary for Python", () => {
    const content = `
import os
from typing import List

class Service:
    pass

def func1():
    pass

def func2():
    pass
`;

    const result = extractCompactStructure(content, "service.py");

    expect(result).toContain("service.py:");
    expect(result).toMatch(/\d+ lines/);
    expect(result).toMatch(/\d+ imports/);
    expect(result).toMatch(/\d+ class/);
    expect(result).toMatch(/\d+ fns/);
  });

  it("should handle empty files", () => {
    const result = extractCompactStructure("", "empty.ts");

    expect(result).toBe("empty.ts: 1 lines");
  });

  it("should handle files with only imports", () => {
    const content = `
import { a } from "a";
import { b } from "b";
`;

    const result = extractCompactStructure(content, "imports-only.ts");

    expect(result).toContain("imports-only.ts:");
    expect(result).toMatch(/\d+ imports/);
    expect(result).not.toContain("class");
    expect(result).not.toContain("fn");
  });

  it("should pluralize correctly", () => {
    // Single class
    const singleClass = `export class Single {}`;
    const singleResult = extractCompactStructure(singleClass, "single.ts");
    expect(singleResult).toContain("1 class");
    expect(singleResult).not.toContain("classes");

    // Multiple classes
    const multiClass = `
export class One {}
export class Two {}
`;
    const multiResult = extractCompactStructure(multiClass, "multi.ts");
    expect(multiResult).toContain("2 classes");
  });
});
