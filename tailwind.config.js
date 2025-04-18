/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Material Design 颜色
        primary: {
          50: '#e3f2fd',
          100: '#bbdefb',
          200: '#90caf9',
          300: '#64b5f6',
          400: '#42a5f5',
          500: '#2196f3', // Material Blue
          600: '#1e88e5',
          700: '#1976d2',
          800: '#1565c0',
          900: '#0d47a1',
        },
        secondary: {
          50: '#fce4ec',
          100: '#f8bbd0',
          200: '#f48fb1',
          300: '#f06292',
          400: '#ec407a',
          500: '#e91e63', // Material Pink
          600: '#d81b60',
          700: '#c2185b',
          800: '#ad1457',
          900: '#880e4f',
        },
        error: '#f44336',    // Material Red
        warning: '#ff9800',  // Material Orange
        info: '#2196f3',     // Material Blue
        success: '#4caf50',  // Material Green
        background: '#fafafa',
        surface: '#ffffff',
        'on-primary': '#ffffff',
        'on-secondary': '#ffffff',
        'on-error': '#ffffff',
        'on-background': '#000000',
        'on-surface': '#000000',
      },
      fontFamily: {
        sans: [
          'Roboto',
          'Google Sans',
          'Arial',
          'sans-serif',
        ],
      },
      borderRadius: {
        'md': '4px',
        'lg': '8px',
        'xl': '12px',
        'full': '9999px',
      },
      boxShadow: {
        'elevation-1': '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
        'elevation-2': '0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23)',
        'elevation-3': '0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23)',
        'elevation-4': '0 14px 28px rgba(0,0,0,0.25), 0 10px 10px rgba(0,0,0,0.22)',
        'elevation-5': '0 19px 38px rgba(0,0,0,0.30), 0 15px 12px rgba(0,0,0,0.22)',
      },
    },
  },
  plugins: [],
};