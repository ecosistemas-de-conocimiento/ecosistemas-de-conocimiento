import type { ReactNode } from 'react'
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts'
import { importMap } from './admin/importMap.js'
import configPromise from '@payload-config'
import type { ServerFunctionClient } from 'payload'

export const metadata = {
  title: 'Ecosistemas de Conocimiento — admin',
}

const serverFunction: ServerFunctionClient = async (args) => {
  'use server'
  return handleServerFunctions({
    ...args,
    config: configPromise,
    importMap,
  })
}

export default async function Layout({ children }: { children: ReactNode }) {
  return RootLayout({
    children,
    config: configPromise,
    importMap,
    serverFunction,
  })
}
