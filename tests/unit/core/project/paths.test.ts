import { describe, expect, it } from 'vitest'
import { projectPaths, resolvePaths } from '#src/core/project/paths.ts'

describe('resolvePaths', () => {
  it('defaults to ~/.config and ~/.local/share', () => {
    const paths = resolvePaths({}, '/home/me')
    expect(paths.configFile).toBe('/home/me/.config/ticketsmith/config.json')
    expect(paths.projectsRoot).toBe('/home/me/.local/share/ticketsmith/projects')
    expect(paths.legacy.profilesDir).toBe('/home/me/.config/ticketsmith/profiles')
    expect(paths.legacy.dataDir('acme')).toBe('/home/me/.local/share/ticketsmith/acme')
  })

  it('honors absolute XDG variables and ignores relative ones', () => {
    expect(
      resolvePaths({ XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' }, '/h').projectsRoot,
    ).toBe('/data/ticketsmith/projects')
    expect(resolvePaths({ XDG_CONFIG_HOME: 'relative' }, '/h').configDir).toBe(
      '/h/.config/ticketsmith',
    )
  })
})

describe('projectPaths', () => {
  it('keeps shared files at the root and machine-local state under local/', () => {
    expect(projectPaths('/p/acme')).toEqual({
      root: '/p/acme',
      projectFile: '/p/acme/project.yaml',
      gitignore: '/p/acme/.gitignore',
      knowledgeDir: '/p/acme/knowledge',
      localDir: '/p/acme/local',
      sqlite: '/p/acme/local/project.sqlite',
      outDir: '/p/acme/local/out',
      auditDir: '/p/acme/local/audit',
      cacheDir: '/p/acme/local/cache',
      reposDir: '/p/acme/local/repos',
      changesDir: '/p/acme/local/changes',
    })
  })
})
