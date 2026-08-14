import { RootPage } from '@payloadcms/next/views'
import { importMap } from '../importMap.js'
import configPromise from '@payload-config'

export default async function Admin({
  params,
  searchParams,
}: {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<Record<string, string | string[]>>
}) {
  return RootPage({
    config: configPromise,
    importMap,
    params,
    searchParams,
  })
}
