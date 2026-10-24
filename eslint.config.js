import js from '@eslint/js';
import globals from 'globals';

const gjsGlobals = {
    ARGV: 'readonly',
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    {
        ignores: ['build/', 'node_modules/'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', {avoidEscape: true, allowTemplateLiterals: true}],
            'comma-dangle': ['error', 'always-multiline'],
            'indent': ['error', 4, {SwitchCase: 0}],
        },
    },
    {
        files: ['src/**/*.js', 'tests/gjs/**/*.js', 'tests/shell/**/*.js'],
        languageOptions: {
            globals: {...globals.es2021, ...gjsGlobals, console: 'readonly'},
        },
    },
    {
        files: ['tests/unit/**/*.js', 'tests/helpers/**/*.js', 'eslint.config.js'],
        languageOptions: {
            globals: {...globals.node},
        },
    },
];
