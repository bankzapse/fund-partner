// ESLint (flat config) — เน้นจับ "บั๊กจริง" ไม่ใช่สไตล์
// เช่น ตัวแปรชนกัน (no-redeclare), เรียกตัวที่ไม่มีอยู่ (no-undef), import ไม่ได้ใช้
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'supabase/**', // ไฟล์ SQL ที่ generate จาก schema.sql ไม่ใช่ JS
      'coverage/**',
    ],
  },

  js.configs.recommended,

  {
    // โค้ดฝั่งเซิร์ฟเวอร์และสคริปต์ (รันบน Node)
    files: ['src/**/*.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.js', 'api/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    // โค้ดฝั่งเบราว์เซอร์ (public/js)
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    rules: {
      // ตัวแปร/พารามิเตอร์ที่ขึ้นต้นด้วย _ ตั้งใจไม่ใช้ ไม่ต้องเตือน
      // ignoreRestSiblings: รูปแบบ { secret, ...rest } ที่ดึงออกเพื่อ "ตัดทิ้ง" ไม่นับว่าไม่ได้ใช้
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // เครื่องมือ CLI ตัดสี ANSI (\x1b) ในผลลัพธ์ terminal โดยตั้งใจ ไม่ใช่บั๊ก
      'no-control-regex': 'off',
      // เป็น smell ไม่ใช่บั๊ก และจับ false positive กับการตั้งค่าเริ่มต้นเชิงป้องกัน
      // เป้าหมายของ lint ชุดนี้คือจับบั๊กจริง ไม่ใช่สไตล์
      'no-useless-assignment': 'off',
    },
  },
];
