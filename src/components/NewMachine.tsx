import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiElevated, AuthError, deployWim, fetchWims, type DeployJob, type WimImage } from '../api'
import type { ClusterResource, IsoVolume } from '../types'
import { place, SIZES, type SizePreset } from '../placement'
import DeployProgress from './DeployProgress'

interface Props {
  resources: ClusterResource[]
  username: string
  onClose: () => void
  onTask: (upid: string, node: string, label: string) => void
  onAuthError: () => void
}

/** Friendly display name for an ISO volid like "local:iso/Windows10_LTSC.iso". */
const isoName = (volid: string) => volid.split('/').pop()?.replace(/\.iso$/i, '') ?? volid

// The same knobs Proxmox's own "Create VM" wizard exposes - the few that
// actually decide whether an OS installs at all. Defaults are chosen so a
// fresh Windows 11 install just works (q35 + a v2 CPU is what it requires;
// i440fx + the default kvm64 CPU is exactly what made VM 107 loop in setup).
const OS_TYPES = [
  { v: 'win11', l: 'Windows 11' },
  { v: 'win10', l: 'Windows 10 / Server 2016-2022' },
  { v: 'l26', l: 'Linux' },
  { v: 'other', l: 'Other' }
]
const MACHINES = [
  { v: 'q35', l: 'q35 - modern (recommended, required for Win 11)' },
  { v: 'i440fx', l: 'i440fx - legacy' }
]
const CPU_TYPES = [
  { v: 'x86-64-v2-AES', l: 'x86-64-v2-AES - recommended (needed by Win 11)' },
  { v: 'host', l: 'host - fastest, matches this server' },
  { v: 'x86-64-v2', l: 'x86-64-v2' },
  { v: 'kvm64', l: 'kvm64 - most compatible, but Win 11 rejects it' }
]
const BIOSES = [
  { v: 'ovmf', l: 'UEFI (OVMF) - recommended' },
  { v: 'seabios', l: 'Legacy (SeaBIOS)' }
]

export default function NewMachine({ resources, username, onClose, onTask, onAuthError }: Props) {
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [sizeId, setSizeId] = useState('M')
  const [custom, setCustom] = useState(false)
  const [cCores, setCCores] = useState(4)
  const [cRam, setCRam] = useState(8)
  const [cDisk, setCDisk] = useState(120)
  const [vmUser, setVmUser] = useState('')
  const [vmPass, setVmPass] = useState('')
  const [isos, setIsos] = useState<IsoVolume[]>([])
  const [isoNodes, setIsoNodes] = useState<Record<string, string[]>>({})
  const [wims, setWims] = useState<WimImage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deployJob, setDeployJob] = useState<DeployJob | null>(null)
  // Advanced (Proxmox-wizard) options - sensible defaults, overridable below.
  const [osType, setOsType] = useState('l26')
  const [machine, setMachine] = useState('q35')
  const [cpuType, setCpuType] = useState('x86-64-v2-AES')
  const [biosType, setBiosType] = useState('ovmf')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // When the image changes, pre-select the right OS type (Windows ISOs and every
  // WIM default to Win 11). The user can still override it in Advanced.
  useEffect(() => {
    if (!image || image.startsWith('tpl:')) return
    setOsType(image.startsWith('wim:') || /win/i.test(image) ? 'win11' : 'l26')
  }, [image])

  // Pull the flat WIM list from the GhostDrive library once. Silent on failure
  // (drive unmounted just means no WIMs offered) so it never blocks the form.
  useEffect(() => {
    let stop = false
    fetchWims().then(w => { if (!stop) setWims(w) }).catch(() => {})
    return () => { stop = true }
  }, [])

  const size: SizePreset = custom
    ? { id: 'Custom', label: 'Custom', cores: cCores, memGb: cRam, diskGb: cDisk }
    : SIZES.find(s => s.id === sizeId) ?? SIZES[1]

  // An ISO can only boot on a node that actually sees it in an image folder;
  // the app mediates that - the tech never has to know or care. Templates and
  // WIMs aren't tied to a node's ISO folder, so they place anywhere.
  const allowedNodes = useMemo(() => {
    if (!image || image.startsWith('tpl:') || image.startsWith('wim:')) return undefined
    return isoNodes[image] ?? []
  }, [image, isoNodes])

  const placement = useMemo(() => place(resources, size, allowedNodes), [resources, size, allowedNodes])

  // Templates are "ready to use" images; the shared img folder supplies installers.
  const templates = useMemo(
    () => resources.filter(r => r.type === 'qemu' && r.template === 1),
    [resources]
  )

  // Ask EVERY node with an iso-capable storage what it can see, and remember
  // which nodes see which image. Re-runs only when the storage layout changes,
  // not on every 5s resource poll.
  const isoStorageKey = useMemo(
    () =>
      resources
        .filter(r => r.type === 'storage' && (r.content ?? '').includes('iso') && r.node)
        .map(r => r.id)
        .sort()
        .join(','),
    [resources]
  )

  useEffect(() => {
    if (!isoStorageKey) return
    const isoStorages = isoStorageKey.split(',').map(id => {
      const [, node, storage] = id.split('/')
      return { node, storage }
    })
    let stop = false
    Promise.all(
      isoStorages.map(s =>
        apiElevated<IsoVolume[]>(`/nodes/${s.node}/storage/${s.storage}/content`, { params: { content: 'iso' } })
          .then(list => ({ node: s.node, list }))
          .catch(() => ({ node: s.node, list: [] as IsoVolume[] }))
      )
    ).then(results => {
      if (stop) return
      const nodesFor: Record<string, string[]> = {}
      const seen = new Map<string, IsoVolume>()
      for (const { node, list } of results) {
        for (const v of list) {
          ;(nodesFor[v.volid] ??= []).push(node)
          if (!seen.has(v.volid)) seen.set(v.volid, v)
        }
      }
      setIsoNodes(nodesFor)
      setIsos([...seen.values()].sort((a, b) => a.volid.localeCompare(b.volid)))
    })
    return () => { stop = true }
  }, [isoStorageKey])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    // WIM library images deploy via the WinPE engine, not a plain VM create.
    if (isWim) {
      const w = wims.find(x => `wim:${x.path}` === image)
      if (!w) { setError('Pick an image'); return }
      setBusy(true)
      const description = `Created with ProxBox\nproxbox:${JSON.stringify({
        user: vmUser, pass: vmPass, image: w.name, by: username, at: new Date().toISOString().slice(0, 10)
      })}`
      try {
        const job = await deployWim({
          name, wim: w.path, cores: size.cores, memory: size.memGb * 1024, disk: size.diskGb, description
        })
        setDeployJob(job)
      } catch (err) {
        if (err instanceof AuthError) { onAuthError(); return }
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
      return
    }
    if (!placement.ok) return
    setBusy(true)
    const { node, storage } = placement.placement
    const description = `Created with ProxBox\nproxbox:${JSON.stringify({
      user: vmUser,
      pass: vmPass,
      image: image.startsWith('tpl:') ? `copy of ${templates.find(t => `tpl:${t.vmid}` === image)?.name}` : isoName(image),
      by: username,
      at: new Date().toISOString().slice(0, 10)
    })}`

    try {
      const vmid = await apiElevated<string>('/cluster/nextid')

      if (image.startsWith('tpl:')) {
        const tpl = templates.find(t => `tpl:${t.vmid}` === image)
        if (!tpl) throw new Error('Pick an image')
        const upid = await apiElevated<string>(`/nodes/${tpl.node}/qemu/${tpl.vmid}/clone`, {
          method: 'POST',
          params: {
            newid: vmid,
            name,
            full: true,
            target: node !== tpl.node ? node : undefined,
            storage
          }
        })
        // Right-size it and stash the login; cloud-init creds apply when the
        // template supports them, and the machine boots ready to use.
        await apiElevated(`/nodes/${node}/qemu/${vmid}/config`, {
          method: 'POST',
          params: {
            cores: size.cores,
            memory: size.memGb * 1024,
            description,
            ciuser: vmUser || undefined,
            cipassword: vmPass || undefined
          }
        }).catch(() => { /* config tweaks apply once the clone task lands */ })
        onTask(upid, tpl.node!, `Spinning up ${name}`)
      } else {
        if (!image) throw new Error('Pick an image')
        const win = osType.startsWith('win')
        const params: Record<string, string | number | boolean | undefined> = {
          vmid,
          name,
          cores: size.cores,
          sockets: 1,
          memory: size.memGb * 1024,
          ostype: osType,
          cpu: cpuType,
          bios: biosType,
          description,
          ide2: `${image},media=cdrom`,
          onboot: false
        }
        // q35 is the modern chipset; i440fx is Proxmox's default so we only send
        // 'machine' when it differs.
        if (machine !== 'i440fx') params.machine = machine
        // An EFI disk (and its pre-enrolled keys) only makes sense under OVMF.
        if (biosType === 'ovmf') params.efidisk0 = `${storage}:1,efitype=4m,pre-enrolled-keys=1`
        if (win) {
          params.ide0 = `${storage}:${size.diskGb}`
          params.scsihw = 'virtio-scsi-single'
          params.net0 = 'e1000,bridge=vmbr0,firewall=1'
          params.boot = 'order=ide0;ide2;net0'
          // TPM 2.0 - Windows 11 refuses to install without it.
          params.tpmstate0 = `${storage}:1,version=v2.0`
        } else {
          params.scsihw = 'virtio-scsi-single'
          params.scsi0 = `${storage}:${size.diskGb},discard=on`
          params.net0 = 'virtio,bridge=vmbr0,firewall=1'
          params.boot = 'order=scsi0;ide2;net0'
        }
        const upid = await apiElevated<string>(`/nodes/${node}/qemu`, { method: 'POST', params })
        onTask(upid, node, `Spinning up ${name}`)
      }
    } catch (err) {
      if (err instanceof AuthError) { onAuthError(); return }
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      return
    }
  }

  const isWim = image.startsWith('wim:')
  const isInstaller = image !== '' && !image.startsWith('tpl:') && !isWim

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>New machine</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label>
          Machine name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Sarah-Test"
            pattern="[A-Za-z0-9\-]+"
            title="Letters, digits and dashes only"
            required
          />
        </label>

        <label>
          Image
          <select value={image} onChange={e => setImage(e.target.value)} required>
            <option value="">- choose what to run -</option>
            {templates.length > 0 && (
              <optgroup label="Ready to use">
                {templates.map(t => (
                  <option key={t.id} value={`tpl:${t.vmid}`}>{t.name}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Fresh install (you complete the OS setup on the screen)">
              {isos.map(v => (
                <option key={v.volid} value={v.volid}>{isoName(v.volid)}</option>
              ))}
            </optgroup>
            {wims.length > 0 && (
              <optgroup label={`Image library — ${wims.length} WIMs`}>
                {wims.map(w => (
                  <option key={w.path} value={`wim:${w.path}`}>{w.name} — {w.sizeGb} GB</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {isWim && (
          <p className="machine-sub muted">
            From the GhostDrive library{image.slice(4).includes('/') ? ` · ${image.slice(4, image.lastIndexOf('/'))}` : ''}
          </p>
        )}

        <fieldset className="sizes">
          <legend>Size</legend>
          {SIZES.map(s => (
            <label key={s.id} className="size-row">
              <input
                type="radio"
                name="size"
                checked={!custom && sizeId === s.id}
                onChange={() => { setCustom(false); setSizeId(s.id) }}
              />
              {s.label}
            </label>
          ))}
          <label className="size-row">
            <input type="radio" name="size" checked={custom} onChange={() => setCustom(true)} />
            Custom - pick exactly what you need
          </label>
          {custom && (
            <div className="custom-size grid2">
              <label>
                CPU cores
                <input type="number" min={1} max={32} value={cCores}
                  onChange={e => setCCores(Math.max(1, Number(e.target.value)))} />
              </label>
              <label>
                RAM (GB)
                <input type="number" min={1} max={128} value={cRam}
                  onChange={e => setCRam(Math.max(1, Number(e.target.value)))} />
              </label>
              <label>
                Disk (GB)
                <input type="number" min={8} max={4096} value={cDisk}
                  onChange={e => setCDisk(Math.max(8, Number(e.target.value)))} />
              </label>
            </div>
          )}
        </fieldset>

        <div className="grid2">
          <label>
            Machine username
            <input value={vmUser} onChange={e => setVmUser(e.target.value)} placeholder="who logs in over RDP" required />
          </label>
          <label>
            Machine password
            <input value={vmPass} onChange={e => setVmPass(e.target.value)} required />
          </label>
        </div>

        {isInstaller && (
          <fieldset className="adv-options">
            <legend>
              <button
                type="button"
                className="adv-toggle"
                onClick={() => setShowAdvanced(s => !s)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? '▾' : '▸'} Advanced options {osType.startsWith('win') && !showAdvanced && '(set for Windows automatically)'}
              </button>
            </legend>
            {showAdvanced && (
              <>
                <div className="grid2">
                  <label>
                    Operating system
                    <select value={osType} onChange={e => setOsType(e.target.value)}>
                      {OS_TYPES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </label>
                  <label>
                    Machine type
                    <select value={machine} onChange={e => setMachine(e.target.value)}>
                      {MACHINES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </label>
                  <label>
                    CPU type
                    <select value={cpuType} onChange={e => setCpuType(e.target.value)}>
                      {CPU_TYPES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </label>
                  <label>
                    BIOS
                    <select value={biosType} onChange={e => setBiosType(e.target.value)}>
                      {BIOSES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </label>
                </div>
                {osType.startsWith('win') && (machine === 'i440fx' || cpuType === 'kvm64') && (
                  <p className="warn">
                    ⚠ Windows 11 needs <strong>q35</strong> and a <strong>v2 CPU</strong> (e.g. x86-64-v2-AES).
                    With i440fx or kvm64 the installer loops. Leave the recommended values unless you know why.
                  </p>
                )}
              </>
            )}
          </fieldset>
        )}

        {isInstaller && (
          <p className="warn">
            ⚠ This is an installer image: after it starts, open its <em>screen</em> and walk through the OS
            setup once - use the username and password above so your RDP login matches.
          </p>
        )}

        {isWim && (
          <p className="warn">
            ⚙ This builds a machine and applies the image for you automatically - it boots itself,
            lays down the image, and comes up ready. Just give it a few minutes.
          </p>
        )}

        {!isWim && !placement.ok && <p className="error" role="alert">⛔ {placement.reason}</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}

        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (!isWim && !placement.ok)}>
            {busy ? (isWim ? 'Starting deploy…' : 'Spinning up…') : isWim ? 'Deploy image' : 'Spin it up'}
          </button>
        </div>
      </form>

      {deployJob && (() => {
        const w = wims.find(x => `wim:${x.path}` === image)
        return (
          <DeployProgress
            job={deployJob}
            name={name}
            imageName={w?.name ?? 'the image'}
            sizeGb={w?.sizeGb ?? 20}
            onDone={onClose}
          />
        )
      })()}
    </div>
  )
}
