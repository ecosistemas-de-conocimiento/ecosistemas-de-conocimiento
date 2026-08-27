import type { ReactNode } from 'react'
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts'
/**
 * 🔴 PAYLOAD'S ADMIN STYLESHEET. Without this the admin panel renders, works,
 * and looks completely broken — unstyled HTML with every control stacked.
 *
 * ⚠ It was missing because this layout came from `chat-backend`, which never
 * had it either. The `identity` app DID (`@payloadcms/next/css` plus its own
 * `custom.scss`), and the merge kept the wrong one of the two. Nothing fails at
 * build or typecheck: a missing stylesheet import is invisible until someone
 * opens the page.
 */
import '@payloadcms/next/css'
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
