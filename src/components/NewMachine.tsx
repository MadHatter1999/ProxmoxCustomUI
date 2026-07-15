import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, apiElevated, AuthError } from '../api'
import type { ClusterResource, IsoVolume } from '../types'
import { place, SIZES, type SizePreset } from '../placement'

interface Props {
  resources: ClusterResource[]
  username: string
  onClose: () => void
  onTask: (upid: string, node: string, label: string) => void
  onAuthError: () => void
}

/** Friendly display name for an ISO volid like "local:iso/Windows10_LTSC.iso". */
const isoName = (volid: string) => volid.split('/').pop()?.replace(/\.iso$/i, '') ?? volid

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const size: SizePreset = custom
    ? { id: 'Custom', label: 'Custom', cores: cCores, memGb: cRam, diskGb: cDisk }
    : SIZES.find(s => s.id === sizeId) ?? SIZES[1]

  // An ISO can only boot on a node that actually sees it in an image folder;
  // the app mediates that - the tech never has to know or care.
  const allowedNodes = useMemo(() => {
    if (!image || image.startsWith('tpl:')) return undefined
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
        apiElevated<IsoVolume[]>(`/nodes/${s.node}/storage/${s.storage}/content`, { content: 'iso' })
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
      const vmid = await api<string>('/cluster/nextid')

      if (image.startsWith('tpl:')) {
        const tpl = templates.find(t => `tpl:${t.vmid}` === image)
        if (!tpl) throw new Error('Pick an image')
        const upid = await api<string>(`/nodes/${tpl.node}/qemu/${tpl.vmid}/clone`, {
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
        await api(`/nodes/${node}/qemu/${vmid}/config`, {
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
        const win = /win/i.test(image)
        const params: Record<string, string | number | boolean | undefined> = {
          vmid,
          name,
          cores: size.cores,
          sockets: 1,
          memory: size.memGb * 1024,
          ostype: win ? 'win10' : 'l26',
          description,
          ide2: `${image},media=cdrom`,
          bios: 'ovmf',
          efidisk0: `${storage}:1,efitype=4m,pre-enrolled-keys=1`,
          onboot: false
        }
        if (win) {
          params.ide0 = `${storage}:${size.diskGb}`
          params.net0 = 'e1000,bridge=vmbr0,firewall=1'
          params.boot = 'order=ide0;ide2;net0'
          params.tpmstate0 = `${storage}:1,version=v2.0`
        } else {
          params.scsihw = 'virtio-scsi-single'
          params.scsi0 = `${storage}:${size.diskGb},discard=on`
          params.net0 = 'virtio,bridge=vmbr0,firewall=1'
          params.boot = 'order=scsi0;ide2;net0'
        }
        const upid = await api<string>(`/nodes/${node}/qemu`, { method: 'POST', params })
        onTask(upid, node, `Spinning up ${name}`)
      }
    } catch (err) {
      if (err instanceof AuthError) { onAuthError(); return }
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      return
    }
  }

  const isInstaller = image !== '' && !image.startsWith('tpl:')

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
          </select>
        </label>

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
          <p className="warn">
            ⚠ This is an installer image: after it starts, open its <em>screen</em> and walk through the OS
            setup once - use the username and password above so your RDP login matches.
          </p>
        )}

        {!placement.ok && <p className="error" role="alert">⛔ {placement.reason}</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}

        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !placement.ok}>
            {busy ? 'Spinning up…' : 'Spin it up'}
          </button>
        </div>
      </form>
    </div>
  )
}
